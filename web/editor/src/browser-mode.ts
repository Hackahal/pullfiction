// Vite fixes this flag to 1 for every application build; headless tests have no Vite environment.
export const BROWSER_ASSETS = import.meta.env?.VITE_BROWSER_ASSETS === "1";

// Authored application artwork. Browser mode never falls back to hosted game art.
export const schematicIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="5" fill="#293039"/><path d="M16 6 26 16 16 26 6 16Z" fill="none" stroke="#caa45d" stroke-width="2"/></svg>')}`;
