export interface GeoResult {
    ip: string;
    country: string;
    countryCode: string;
    lat: number;
    lon: number;
    zone: 'TH' | 'SG' | 'JP';
    ping: string;
}
export declare function geolocate(ip: string): Promise<GeoResult>;
//# sourceMappingURL=ip-geolocation.d.ts.map