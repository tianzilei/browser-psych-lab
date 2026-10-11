/** Keep transport codes available for diagnostics without using them as UI copy. */
export class RequestError extends Error {
  constructor(readonly code:string,readonly status:number,readonly details?:unknown){
    super(`${code}${details==null?'':`：${JSON.stringify(details)}`}`);
    this.name='RequestError';
  }
}
