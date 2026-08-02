import { prisma } from "@/lib/db";
import { CLIFTON_NJ } from "@/lib/places/googlePlaces";
import { buildLocalFirms } from "@/lib/localFirms";

export type NearbySearchPreference = { centerAddress:string; lat:number; lng:number; radiusMiles:number };
const SETTING_KEY="nearbySearch";
export async function getNearbySearchPreference():Promise<NearbySearchPreference>{const setting=await prisma.appSetting.findUnique({where:{key:SETTING_KEY}});if(setting)return JSON.parse(setting.value);return{centerAddress:"Clifton, NJ",lat:CLIFTON_NJ.lat,lng:CLIFTON_NJ.lng,radiusMiles:50}}
export async function setNearbySearchPreference(pref:NearbySearchPreference){await prisma.appSetting.upsert({where:{key:SETTING_KEY},update:{value:JSON.stringify(pref)},create:{key:SETTING_KEY,value:JSON.stringify(pref)}})}
export type NearbySearchSummary={configured:boolean;discovered:number;promoted:number};
// Compatibility wrapper retained for the scheduler. It no longer queries Google
// or directories; it rebuilds Local Firms from approved employers and exact
// LIVE_JOB_VERIFIED locations only.
export async function runNearbyFirmSearch():Promise<NearbySearchSummary>{const pref=await getNearbySearchPreference();const result=await buildLocalFirms(pref.radiusMiles);return{configured:true,discovered:result.firms.length,promoted:0}}
