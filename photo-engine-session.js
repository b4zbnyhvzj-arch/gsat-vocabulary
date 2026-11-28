import {deadline, errorDetails} from "./ocr-task.js";

const workerEvents=["error","messageerror"];

export function createEngineSession({load,workerURL,WorkerClass=globalThis.Worker,
  timeouts={init:60000,inference:45000,dispose:650},log=()=>{}}) {
  let state=null;
  async function release(reason="批次結束", graceful=true) {
    const old=state;
    if(!old) return;
    state=null;
    old.closed=true;
    if(graceful&&old.runner) {
      try {await deadline("釋放模型",timeouts.dispose,null,()=>old.runner.dispose());}
      catch(error) {log("dispose-error",{reason,error:errorDetails(error)});}
    }
    // The vendor dispose awaits an RPC before terminating. Our retained handle
    // terminates even if that RPC, initialize, or inference never settles.
    if(old.worker) {
      old.worker.terminate();
      // Release vendor pending RPC promises after terminating the actual worker.
      old.worker.dispatchEvent(new ErrorEvent("error",{message:"OCR worker 已終止。"}));
    }
    log("worker-stopped",{reason,generation:old.generation});
  }

  let generation=0;
  async function ready(signal) {
    if(state?.runner) return state.runner;
    if(state) throw new Error("OCR 模型尚在初始化。");
    const handle={generation:++generation,closed:false};
    state=handle;
    log("initializing",{generation});
    try {
      handle.runner=await deadline("載入 OCR 模型",timeouts.init,signal,()=>load(()=>{
        if(handle.closed||signal?.aborted) throw new DOMException("原 OCR 任務已結束。","AbortError");
        if(handle.worker) throw new Error("同一次初始化只允許一個辨識 Worker。");
        const worker=new WorkerClass(workerURL,{type:"module"});
        for(const event of workerEvents) worker.addEventListener(event,()=>log("worker-"+event,{generation:handle.generation}));
        handle.worker=worker;
        return worker;
      }));
      log("engine-ready",{generation});
      return handle.runner;
    } catch(error) {
      await release("初始化失敗",false);
      throw error;
    }
  }

  async function predict(canvas,signal) {
    let runner;
    try {runner=await ready(signal);}
    catch(error) {
      if (signal.aborted) throw error;
      throw new Error("模型／WASM 載入失敗。請重試；若仍失敗，可重新下載離線模型。",{cause:error});
    }
    try {
      return await deadline("照片辨識",timeouts.inference,signal,()=>runner.recognize(canvas));
    } catch(error) {
      await release("辨識失敗或停止",false);
      if(signal.aborted) throw error;
      throw new Error("OCR 辨識失敗："+error.message+"。可選 1600 px 後重試。",{cause:error});
    }
  }
  return {predict,release};
}
