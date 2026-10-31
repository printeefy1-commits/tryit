// Relative to this module so versioned entrypoints keep one deployment's
// dependency graph together. Legacy root URLs still work for tools and tests.
export function assetUrl(path){return new URL(path.replace(/^\//,''),new URL('./',import.meta.url)).pathname;}
