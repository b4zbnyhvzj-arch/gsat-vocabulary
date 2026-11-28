import {documentedForms} from "../verb-lexicon.js";

// Selected common inflections. The preview labels each of these as a suggestion.
const irregular = {
  be:"was/were been", begin:"began begun", break:"broke broken", bring:"brought brought",
  buy:"bought bought", choose:"chose chosen", come:"came come", do:"did done", eat:"ate eaten",
  find:"found found", give:"gave given", go:"went gone", know:"knew known", make:"made made",
  read:"read read", run:"ran run", see:"saw seen", shed:"shed shed", take:"took taken",
  teach:"taught taught", think:"thought thought", write:"wrote written",
};
const noDoubling=new Set(["answer","enter","offer","open","shelter","visit","ballot"]);
const noRule = new Set(["bear","beware","beat","become","bend","bite","blow","build","catch","cost","cut",
  "deal","dig","draw","drink","drive","fall","feel","fight","fly","forget","freeze","get","grow",
  "have","hear","hide","hit","hold","hurt","keep","lay","lead","leave","lend","let","lie","light",
  "lose","mean","meet","pay","put","ride","ring","rise","say","seek","sell","send","set","shake",
  "shoot","show","shut","sing","sit","sleep","speak","spend","stand","steal","stick","swear","swim",
  "tear","tell","throw","understand","wake","wear","win"]);
export function suggestForms(base,{firstSyllableStress=false,documented=false}={}) {
  const listed=documented?documentedForms(base):null;
  if (listed) return {base,past:listed[0],pastParticiple:listed[1],origin:"dictionary",sources:[]};
  if (!/^[a-z]+$/.test(base)||noRule.has(base)) return null;
  const pair=Object.hasOwn(irregular,base)?irregular[base].split(" "):null;
  if (pair) return {base,past:pair[0],pastParticiple:pair[1],origin:"suggested",sources:[]};
  let past;
  if (/e$/.test(base)) past=base+"d";
  else if (/[^aeiou]y$/.test(base)) past=base.slice(0,-1)+"ied";
  else if (/[^aeiou][aeiou][b-dg-lmnp-tvz]$/.test(base)&&!base.endsWith("ll")&&!noDoubling.has(base)) {
    if ((base.match(/[aeiouy]+/g)??[]).length===1) past=base+base.at(-1)+"ed";
    else if (firstSyllableStress) past=base+"ed";
    else return null;
  } else if (/c$/.test(base)) return null;
  else past=base+"ed";
  return {base,past,pastParticiple:past,origin:"suggested",sources:[]};
}

const invariant = new Set(["species","series","deer","sheep","fish","news","scissors","trousers","glasses"]);
const singular = {people:"person",children:"child",men:"man",women:"woman",teeth:"tooth",feet:"foot",mice:"mouse",geese:"goose"};
export function singularNoun(word) {
  const key=word.toLowerCase();
  if (!/^[a-z]+$/.test(key)||invariant.has(key)) return word;
  if (Object.hasOwn(singular,key)) return singular[key];
  if (/[^aeiou]ies$/.test(key)) return key.slice(0,-3)+"y";
  if (/(?:ches|shes|xes|sses)$/.test(key)) return key.slice(0,-2);
  if (/[^sui]s$/.test(key)) return key.slice(0,-1);
  return word;
}

export function adjectiveFor(adjective, adverb) {
  const word=adjective.toLowerCase();
  const derived=/[^aeiou]y$/.test(word) ? word.slice(0,-1)+"ily" :
    /ic$/.test(word) ? word+"ally" :
    /[^aeiou]le$/.test(word) ? word.slice(0,-1)+"y" : word+"ly";
  return derived===adverb.toLowerCase();
}
