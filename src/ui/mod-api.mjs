let provider=null;
export const apiVersion=1;
export function installModApi(value){provider=value;}
export function getModHost(){if(!provider)throw Error('模组接口尚未就绪');return provider;}
export function getEditor(){return getModHost().editor;}
export default getEditor;
