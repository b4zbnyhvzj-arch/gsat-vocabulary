import {parseEntries} from "./ocr-app-v083/entry-parser.js";
import {traditionalConverter} from "./photo-traditional.js";
import {errorDetails} from "./ocr-task.js";

self.onmessage = async ({data}) => {
  try {self.postMessage({parsed:parseEntries(data,{strict:true,standardize:await traditionalConverter()})});}
  catch(error) {self.postMessage({error:errorDetails(error)});}
};
