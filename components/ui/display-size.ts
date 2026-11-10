export type DisplayEnvironment={availWidth?:number;availHeight?:number;innerWidth?:number;innerHeight?:number;outerWidth?:number;outerHeight?:number;devicePixelRatio?:number;coarsePointer?:boolean};
export type DisplaySize={width:number;height:number;dpr:number;popupWidth:number;popupHeight:number;mobile?:true};
const valid=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>0?value:undefined;
/** Space the secure-browser page header takes above the viewer on a phone, in CSS pixels. */
export const MOBILE_HEADER_CSS_PX=48;
const MOBILE_MAX_SHORT_SIDE=500;
export function chooseDisplaySize(env:DisplayEnvironment):DisplaySize{
 const innerWidth=valid(env.innerWidth)??800,innerHeight=valid(env.innerHeight)??600;
 // avail* is already expressed in CSS pixels and excludes operating-system UI.
 // Browser chrome affects the popup's inner area, but the backend wants the full
 // available-screen capability and applies its own framebuffer bounds.
 const popupWidth=Math.floor(valid(env.availWidth)??innerWidth),popupHeight=Math.floor(valid(env.availHeight)??innerHeight);
 const dpr=valid(env.devicePixelRatio)??1;
 // Phones: size the remote CSS viewport to the space the viewer actually gets,
 // in portrait, so Canvas and the identity provider render their mobile layouts.
 if(env.coarsePointer===true&&Math.min(popupWidth,popupHeight)<=MOBILE_MAX_SHORT_SIDE){
  const portrait=innerWidth<=innerHeight;
  const width=Math.floor(portrait?innerWidth:Math.min(popupWidth,popupHeight));
  const height=Math.floor((portrait?innerHeight:Math.max(popupWidth,popupHeight))-MOBILE_HEADER_CSS_PX);
  return{width,height,dpr,popupWidth,popupHeight,mobile:true};
 }
 return{width:popupWidth,height:popupHeight,dpr,popupWidth,popupHeight};
}
