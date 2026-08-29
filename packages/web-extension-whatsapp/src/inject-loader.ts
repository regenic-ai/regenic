declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

void import(chrome.runtime.getURL("content-script.js"));
