export const AUTO_TIME_ZONE="auto";
// Constructing an Intl.DateTimeFormat costs tens of microseconds to a millisecond (ICU pattern
// and zone lookup), and the view builders format hundreds of dates per request. Instances are
// immutable, so they are shared by (locale, options).
const formatters=new Map<string,Intl.DateTimeFormat>();
export function dateFormatter(locale:string,options:Intl.DateTimeFormatOptions){const key=locale+"|"+JSON.stringify(options);let formatter=formatters.get(key);if(!formatter){if(formatters.size>300)formatters.clear();formatter=new Intl.DateTimeFormat(locale,options);formatters.set(key,formatter)}return formatter}
const zoneValidity=new Map<string,boolean>();
export function validTimeZone(value:unknown):value is string{if(typeof value!=="string"||value.length>100)return false;if(value===AUTO_TIME_ZONE)return true;const known=zoneValidity.get(value);if(known!==undefined)return known;let valid=true;try{new Intl.DateTimeFormat("en-US",{timeZone:value}).format(0)}catch{valid=false}if(zoneValidity.size>300)zoneValidity.clear();zoneValidity.set(value,valid);return valid}
export function resolveTimeZone(preference:unknown,browserZone?:unknown){if(typeof preference==="string"&&preference!==AUTO_TIME_ZONE&&validTimeZone(preference))return preference;if(typeof browserZone==="string"&&validTimeZone(browserZone)&&browserZone!==AUTO_TIME_ZONE)return browserZone;return"UTC"}
export function formatInstant(value:string|Date,zone:string,options:Intl.DateTimeFormatOptions={dateStyle:"medium",timeStyle:"short"}){const instant=value instanceof Date?value:new Date(value);if(!Number.isFinite(instant.getTime()))return"Unknown";return dateFormatter("en-US",{...options,timeZone:resolveTimeZone(zone)}).format(instant)}
export function localDateKey(value:string|Date,zone:string){const instant=value instanceof Date?value:new Date(value);if(!Number.isFinite(instant.getTime()))return"";const parts=dateFormatter("en-CA",{timeZone:resolveTimeZone(zone),year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(instant);const get=(type:string)=>parts.find(p=>p.type===type)?.value??"";return`${get("year")}-${get("month")}-${get("day")}`}
