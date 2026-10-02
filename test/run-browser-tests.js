/*
 * Run the jQuery QUnit browser suite (test/index.html) in headless Chrome
 * and report the results on stdout.
 *
 * Requires a modern Node (>= 18) and puppeteer-core. This script is NOT run
 * by the project's own Node 0.10 toolchain; on Travis it runs via
 * `nvm exec 18 node test/run-browser-tests.js`.
 *
 * Usage:
 *   node test/run-browser-tests.js [url]
 *
 * Environment:
 *   TEST_URL             page to open (default http://127.0.0.1:8000/test/index.html)
 *   CHROME_BIN           Chrome/Chromium executable (auto-detected if unset)
 *   TEST_GLOBAL_TIMEOUT  overall timeout in seconds (default 1200 = 20 minutes)
 *   PUPPETEER_CORE_DIR   extra node_modules dir to look up puppeteer-core in
 *                        (default /tmp/browser-runner/node_modules, NODE_PATH
 *                        works as well)
 *
 * Exit status: 0 only when at least one test ran and none failed, else 1.
 */
"use strict";

var fs = require( "fs" );
var path = require( "path" );

var url = process.argv[ 2 ] || process.env.TEST_URL ||
	"http://127.0.0.1:8000/test/index.html";
var globalTimeoutSec = parseInt( process.env.TEST_GLOBAL_TIMEOUT, 10 ) || 20 * 60;

// Resolve puppeteer-core from NODE_PATH or the side-installed runner deps,
// so it never has to live in the project's own node_modules.
function loadPuppeteer() {
	var extraDir = process.env.PUPPETEER_CORE_DIR || "/tmp/browser-runner/node_modules";
	try {
		return require( "puppeteer-core" );
	} catch ( e ) {
		return require( require.resolve( "puppeteer-core", { paths: [ extraDir ] } ) );
	}
}

// Locate the Chrome binary: $CHROME_BIN first, then well-known locations.
function findChrome() {
	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	var names = [ "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" ];
	var dirs = ( process.env.PATH || "" ).split( path.delimiter ).concat( [ "/usr/bin" ] );
	for ( var i = 0; i < names.length; i++ ) {
		for ( var j = 0; j < dirs.length; j++ ) {
			var candidate = path.join( dirs[ j ], names[ i ] );
			try {
				fs.accessSync( candidate, fs.constants.X_OK );
				return candidate;
			} catch ( e ) { /* keep looking */ }
		}
	}
	throw new Error( "Chrome not found; set CHROME_BIN" );
}

// Injected into every document before any page script runs. It traps the
// assignment `window.QUnit = QUnit` (end of qunit.js, QUnit 1.14) and
// registers the logging callbacks on the real QUnit object. Results are sent
// back through the functions exposed with page.exposeFunction().
function hookQUnit() {
	// Iframe fixtures reuse parent.QUnit; only the top-level page reports.
	if ( window !== window.top ) {
		return;
	}

	var qunit;
	var failedAssertions = [];

	function dump( value ) {
		try {
			return qunit.jsDump.parse( value );
		} catch ( e ) {
			return String( value );
		}
	}

	function register( Q ) {
		Q.moduleStart( function( details ) {
			window.__qunitModuleStart( details.name );
		} );
		Q.testStart( function() {
			failedAssertions = [];
		} );
		Q.log( function( details ) {
			if ( details.result ) {
				return;
			}
			var failure = { message: details.message || "(no message)" };
			if ( details.hasOwnProperty( "expected" ) ) {
				failure.expected = dump( details.expected );
				failure.actual = dump( details.actual );
			}
			if ( details.source ) {
				failure.source = details.source;
			}
			failedAssertions.push( failure );
		} );
		Q.testDone( function( details ) {
			window.__qunitTestDone( {
				module: details.module,
				name: details.name,
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				duration: details.duration,
				assertions: failedAssertions
			} );
			failedAssertions = [];
		} );
		Q.done( function( details ) {
			window.__qunitDone( details );
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunit;
		},
		set: function( value ) {
			if ( value && value !== qunit && typeof value.testDone === "function" ) {
				qunit = value;
				register( value );
			} else {
				qunit = value;
			}
		}
	} );
}

function main() {
	var puppeteer = loadPuppeteer();
	var chrome = findChrome();
	var browser;

	var stats = { passed: 0, failed: 0 };
	var failures = [];
	var finished = false;

	function finish( code, message ) {
		if ( finished ) {
			return;
		}
		finished = true;
		if ( message ) {
			console.log( message );
		}
		var close = browser ? browser.close().catch( function() {} ) : Promise.resolve();
		var killTimer = setTimeout( function() {
			process.exit( code );
		}, 10000 );
		close.then( function() {
			clearTimeout( killTimer );
			process.exit( code );
		} );
	}

	setTimeout( function() {
		finish( 1, "ERROR: global timeout of " + globalTimeoutSec +
			"s reached before QUnit finished (" + stats.passed + " passed, " +
			stats.failed + " failed so far)" );
	}, globalTimeoutSec * 1000 ).unref();

	console.log( "Chrome: " + chrome );
	console.log( "Opening " + url );

	return puppeteer.launch( {
		executablePath: chrome,
		// Headless mode is selected explicitly through the flag below.
		headless: false,
		args: [ "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 1, "ERROR: browser disconnected before QUnit finished" );
		} );
		return browser.newPage();
	} ).then( function( page ) {
		page.on( "console", function( msg ) {
			if ( msg.type() === "error" ) {
				console.log( "[console.error] " + msg.text() );
			}
		} );
		page.on( "pageerror", function( err ) {
			console.log( "[pageerror] " + ( err && err.message || err ) );
		} );
		page.on( "requestfailed", function( req ) {
			var failure = req.failure();
			// Aborted requests are expected (ajax abort/timeout tests).
			if ( failure && failure.errorText !== "net::ERR_ABORTED" ) {
				console.log( "[requestfailed] " + req.url() + " " + failure.errorText );
			}
		} );

		return Promise.all( [
			page.exposeFunction( "__qunitModuleStart", function( name ) {
				console.log( "\nModule: " + name );
			} ),
			page.exposeFunction( "__qunitTestDone", function( t ) {
				var label = t.module + " :: " + t.name;
				if ( t.failed === 0 ) {
					stats.passed++;
					console.log( "PASS " + label + " (" + t.total + " assertions)" );
					return;
				}
				stats.failed++;
				failures.push( label );
				console.log( "FAIL " + label + " (" + t.failed + " of " + t.total +
					" assertions failed)" );
				t.assertions.forEach( function( a ) {
					console.log( "    - " + a.message );
					if ( "expected" in a ) {
						console.log( "      expected: " + a.expected );
						console.log( "      actual:   " + a.actual );
					}
					if ( a.source ) {
						console.log( "      at " + a.source.split( "\n" )[ 0 ].trim() );
					}
				} );
			} ),
			page.exposeFunction( "__qunitDone", function( d ) {
				var total = stats.passed + stats.failed;
				console.log( "" );
				if ( failures.length ) {
					console.log( "Failed tests:" );
					failures.forEach( function( f ) {
						console.log( "  " + f );
					} );
				}
				console.log( "Tests: " + stats.passed + " passed, " + stats.failed +
					" failed, " + total + " total; Assertions: " + d.passed + " passed, " +
					d.failed + " failed, " + d.total + " total; runtime " +
					( d.runtime / 1000 ).toFixed( 1 ) + "s" );
				var ok = stats.failed === 0 && d.failed === 0 && total > 0;
				finish( ok ? 0 : 1, ok ? null : "RESULT: FAILED" );
			} ),
			page.evaluateOnNewDocument( hookQUnit )
		] ).then( function() {
			return page.goto( url, { waitUntil: "load", timeout: 120000 } );
		} ).then( function( response ) {
			if ( !response || !response.ok() ) {
				finish( 1, "ERROR: failed to load " + url + " (HTTP " +
					( response ? response.status() : "no response" ) + ")" );
			}
		} );
	} );
}

main().catch( function( err ) {
	console.log( "ERROR: " + ( err && err.stack || err ) );
	process.exit( 1 );
} );
