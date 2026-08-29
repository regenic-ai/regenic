declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/**
 * Chrome injects `content_scripts` / `executeScript({ files })` as classic
 * scripts. A top-level `import` in content-script.js throws.
 * Dynamic import() here loads that file as a module.
 */
void import(chrome.runtime.getURL("content-script.js")).catch(() => undefined);
