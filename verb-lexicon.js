// Offline exceptions. Cambridge and Oxford learner dictionaries document
// defective "beware"; Oxford lists "outfitted" for the compound "outfit".
const baseOnly = new Set(["beware"]);
const exceptions = Object.freeze({
  outfit: ["outfitted", "outfitted"],
  fit: ["fitted/fit", "fitted/fit"],
});
export const isBaseOnlyVerb = english => baseOnly.has(english.trim().toLowerCase());
export const documentedForms = english => Object.hasOwn(exceptions, english) ? exceptions[english] : null;
