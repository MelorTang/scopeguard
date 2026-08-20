// Keep the Electron-only launch marker out of Pi and every Tool child process.
delete process.env.ELECTRON_RUN_AS_NODE;

export {};
