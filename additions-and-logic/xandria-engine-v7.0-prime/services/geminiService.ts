import { SYSTEM_DNA } from '../constants';

const API_URL = process.env.NODE_ENV === 'production'
  ? '/api/manifest'
  : 'http://localhost:3000/api/manifest';

export async function manifestIntent(intent: string, assetsContext: any[] = []) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, assetsContext }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const parsed = await response.json();
    return parsed;
  } catch (error) {
    console.error('Xandria Manifestation Error:', error);
    throw error;
  }
}
