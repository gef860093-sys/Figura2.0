/**
 * IP Geolocation — แนะนำ zone ที่ใกล้ที่สุด
 * ใช้ ip-api.com (ฟรี ไม่ต้อง API key)
 */
import axios from 'axios';
import { LRUCache } from './lru-cache';

export interface GeoResult {
  ip: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  zone: 'TH' | 'SG' | 'JP';
  ping: string;
}

// Zone centers (lat, lon)
const ZONES = {
  TH: { lat: 13.75, lon: 100.52, ping: '< 20 ms' },
  SG: { lat: 1.35,  lon: 103.82, ping: '20-50 ms' },
  JP: { lat: 35.69, lon: 139.69, ping: '80-120 ms' },
};

function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function nearestZone(lat: number, lon: number): keyof typeof ZONES {
  let best: keyof typeof ZONES = 'TH';
  let bestDist = Infinity;
  for (const [zone, center] of Object.entries(ZONES)) {
    const d = distKm(lat, lon, center.lat, center.lon);
    if (d < bestDist) { bestDist = d; best = zone as keyof typeof ZONES; }
  }
  return best;
}

const cache = new LRUCache<string, GeoResult>(500, 60 * 60 * 1000); // 1h TTL

export async function geolocate(ip: string): Promise<GeoResult> {
  const cached = cache.get(ip);
  if (cached) return cached;

  // Skip private/loopback IPs
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    const result: GeoResult = { ip, country: 'Local', countryCode: 'XX', lat: ZONES.TH.lat, lon: ZONES.TH.lon, zone: 'TH', ping: ZONES.TH.ping };
    cache.set(ip, result);
    return result;
  }

  try {
    const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,lat,lon`, { timeout: 3000 });
    if (res.data?.status === 'success') {
      const { country, countryCode, lat, lon } = res.data;
      const zone = nearestZone(lat, lon);
      const result: GeoResult = { ip, country, countryCode, lat, lon, zone, ping: ZONES[zone].ping };
      cache.set(ip, result);
      return result;
    }
  } catch { /* fallback */ }

  const result: GeoResult = { ip, country: 'Unknown', countryCode: '??', lat: ZONES.TH.lat, lon: ZONES.TH.lon, zone: 'TH', ping: ZONES.TH.ping };
  cache.set(ip, result);
  return result;
}
