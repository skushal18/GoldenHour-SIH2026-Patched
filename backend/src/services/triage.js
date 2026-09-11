'use strict';
function haversine(lat1,lng1,lat2,lng2){
  if ([lat1,lng1,lat2,lng2].some(v => v==null||v===''||Number.isNaN(Number(v)))) return null;
  const R=6371, toRad=d=>Number(d)*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));
}
function roundKm(km){ return km==null?null:Math.round(km*10)/10; }
const num = v => (v==null||v===''||Number.isNaN(Number(v)))?null:Number(v);
function computePriority(vitals, consciousness, caseTypeId){
  const v=vitals||{};
  const sbp=num(v.systolic_bp), spo2=num(v.spo2), hr=num(v.heart_rate), rr=num(v.resp_rate);
  if (Number(caseTypeId)===9) return 'RED';
  if (consciousness==='Unconscious') return 'RED';
  if (sbp!=null && sbp<90) return 'RED';
  if (spo2!=null && spo2<90) return 'RED';
  if (hr!=null && (hr>150||hr<40)) return 'RED';
  if (rr!=null && (rr>30||rr<8)) return 'RED';
  if (consciousness==='Semi-Conscious') return 'AMBER';
  if (sbp!=null && sbp<110) return 'AMBER';
  if (spo2!=null && spo2<95) return 'AMBER';
  if (hr!=null && (hr>120||hr<50)) return 'AMBER';
  if (rr!=null && (rr>24||rr<10)) return 'AMBER';
  return 'GREEN';
}
function criticalFlags(vitals, consciousness, caseTypeId){
  const v=vitals||{};
  return {
    shock: num(v.systolic_bp)!=null && num(v.systolic_bp)<90,
    hypoxia: num(v.spo2)!=null && num(v.spo2)<90,
    low_gcs: consciousness==='Unconscious',
    cardiac_arrest: Number(caseTypeId)===9,
    airway_compromise: Number(caseTypeId)===18,
  };
}
const PRIORITY_TO_DB = { RED:'CRITICAL', AMBER:'HIGH', GREEN:'MEDIUM' };
module.exports = { haversine, roundKm, computePriority, criticalFlags, PRIORITY_TO_DB };
