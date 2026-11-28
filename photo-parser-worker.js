import {applyGlossRecovery} from "./photo-gloss-recovery.js";
import {parseEntries} from "./ocr-app-v084/entry-parser.js";
import {traditionalConverter} from "./photo-traditional.js";
import {errorDetails} from "./ocr-task.js";

self.onmessage = async ({data}) => {
  try {
    const standardize=await traditionalConverter();
    const parsed=parseEntries(data,{strict:true,automaticImport:true,standardize});
    self.postMessage({parsed:applyGlossRecovery(parsed,data.recovery,standardize)});
  }
  catch(error) {self.postMessage({error:errorDetails(error)});}
};
