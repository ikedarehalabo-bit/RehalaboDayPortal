/**
 * Google Maps 連携（サーバー専用）。GOOGLE_MAPS_API_KEY を env から読む。
 * - geocodeAddress: 住所→座標（Geocoding API）。初回1回だけ使用。
 * - travelMatrix: 地点間の車移動時間（Routes API computeRouteMatrix・秒）。
 * 必要な有効化: GCPで「Geocoding API」「Routes API」を有効化。
 */
export type LatLng = { lat: number; lng: number };

function apiKey(): string {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  return k;
}

/** APIキー失効・API無効・上限超過など設定側の致命的エラー（住所不正とは区別してUIに知らせる）。 */
export class GeocodeConfigError extends Error {}

/**
 * 住所→座標。
 * - 住所が特定できない（ZERO_RESULTS等）＝ null（住所側の問題）
 * - APIキー失効・API無効・上限超過など設定側の致命的エラー＝ GeocodeConfigError を投げる
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    address,
  )}&region=jp&language=ja&key=${apiKey()}`;
  const res = await fetch(url);
  if (!res.ok) throw new GeocodeConfigError(`geocode HTTP ${res.status}`);
  const data = (await res.json()) as {
    status: string;
    error_message?: string;
    results?: { geometry: { location: LatLng } }[];
  };
  if (["REQUEST_DENIED", "OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "INVALID_REQUEST"].includes(data.status)) {
    throw new GeocodeConfigError(data.error_message || data.status);
  }
  if (data.status !== "OK" || !data.results?.length) return null;
  return data.results[0].geometry.location;
}

/**
 * points[i]→points[j] の車移動時間（秒）行列。Routes API computeRouteMatrix。
 * points 数 n に対し n×n（625要素まで1回）。
 */
export async function travelMatrix(points: LatLng[]): Promise<number[][]> {
  const n = points.length;
  const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration",
    },
    body: JSON.stringify({
      origins: points.map(wp),
      destinations: points.map(wp),
      travelMode: "DRIVE",
    }),
  });
  if (!res.ok) throw new Error(`computeRouteMatrix ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as { originIndex: number; destinationIndex: number; duration?: string }[];
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (const r of rows) {
    const sec = r.duration ? parseInt(String(r.duration).replace(/s$/, ""), 10) : 0;
    if (Number.isFinite(r.originIndex) && Number.isFinite(r.destinationIndex)) {
      m[r.originIndex][r.destinationIndex] = sec || 0;
    }
  }
  return m;
}
