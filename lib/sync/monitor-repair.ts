export type MonitorRepairAction="repair-once"|"stop-auth-required"|"retry";
export function monitorRepairAction(sessionStatus:string|undefined,errorCode:string):MonitorRepairAction{
  if(errorCode==="BROWSER_SESSION_NOT_FOUND"&&sessionStatus==="auth_required")return"stop-auth-required";
  if(["BROWSER_SESSION_NOT_FOUND","BROWSER_HOST_ERROR"].includes(errorCode)&&["provisioning","failed"].includes(sessionStatus??""))return"repair-once";
  return"retry";
}
