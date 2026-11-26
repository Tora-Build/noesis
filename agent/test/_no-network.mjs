// Imported by every test file. Any real network call fails the test.
globalThis.fetch = async (url) => { throw new Error(`Network is blocked in tests: ${url}`); };
