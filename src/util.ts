import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fail } from './errors.ts'
/** Deterministic serialization of the validated logical request (not credentials). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const object = value as Record<string, unknown>
  return '{' + Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => JSON.stringify(k)+':'+canonical(object[k])).join(',') + '}'
}
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
export function fingerprint(value: unknown): string { return digest(canonical(value)) }
export function secret(): string { return randomBytes(32).toString('base64url') }
export function equalSecret(a: string, b: string): boolean { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y) }
export function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT','Expected an object.'); return value as Record<string, unknown> }
export function string(value: unknown, name: string, max = 8192): string { if(typeof value!=='string' || value.length===0 || Buffer.byteLength(value)>max) fail('INVALID_ARGUMENT',`${name} must be a nonempty bounded string.`); return value }
export function integer(value: unknown, name: string, min: number, max: number): number { if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) fail('INVALID_ARGUMENT',`${name} must be an integer between ${min} and ${max}.`);return value }
export function noExtra(value: Record<string, unknown>, fields: string[]): void { for(const key of Object.keys(value)) if(!fields.includes(key)) fail('INVALID_ARGUMENT',`Unknown field: ${key}`) }
export function signed(secretKey: string, value: unknown): string { const body=Buffer.from(canonical(value)).toString('base64url');return body+'.'+createHmac('sha256',secretKey).update(body).digest('base64url') }
export function unsign(secretKey: string, value: string): Record<string,unknown> { const [body,mac,...rest]=value.split('.');if(!body||!mac||rest.length||!equalSecret(mac,createHmac('sha256',secretKey).update(body).digest('base64url'))) fail('PERMISSION_REQUIRED','Cursor or token is invalid.');try{return record(JSON.parse(Buffer.from(body,'base64url').toString('utf8')))}catch(error){fail('PERMISSION_REQUIRED','Cursor or token cannot be decoded.')} }
