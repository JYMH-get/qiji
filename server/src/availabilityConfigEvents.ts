/** Leaf notifier avoids coupling model/channel stores to dashboard imports. */
type Change = { resetModelId?:string; resetChannelId?:string };
const listeners=new Set<(change:Change)=>void>();
export function onAvailabilityConfigChange(listener:(change:Change)=>void){listeners.add(listener);}
export function notifyAvailabilityConfigChange(change:Change={}){for(const listener of listeners)listener(change);}
