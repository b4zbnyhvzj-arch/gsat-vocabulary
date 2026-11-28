export function abortError() {
  return new DOMException("已取消辨識。","AbortError");
}
export function deadline(name, milliseconds, signal, operation) {
  if (signal?.aborted) return Promise.reject(abortError());
  let timer, abort;
  return Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
    abort=()=>reject(abortError());
    signal?.addEventListener("abort",abort,{once:true});
    timer=setTimeout(()=>reject(new DOMException(name+"逾時。","TimeoutError")),milliseconds);
  })]).finally(()=>{
    clearTimeout(timer);
    signal?.removeEventListener("abort",abort);
  });
}
export function errorDetails(error) {
  return {name:error?.name??"Error",message:String(error?.message??error),
    stack:typeof error?.stack==="string"?error.stack:undefined,
    ...(error?.cause?{cause:{name:error.cause.name,message:String(error.cause.message??error.cause)}}:{})};
}
