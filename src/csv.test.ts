import {describe, expect, it} from 'vitest'
import {parseCsv, parseLengthMs, parseWantlistCsv} from './csv.js'

describe('parseCsv', () => {
  it('splits simple rows and trims blank lines', () => {
    expect(parseCsv('a,b\nc,d\n\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('handles quoted fields with commas, escaped quotes, and newlines', () => {
    expect(parseCsv('"a,b","say ""hi""","line1\nline2"')).toEqual([['a,b', 'say "hi"', 'line1\nline2']])
  })

  it('handles CRLF and a missing trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('parseLengthMs', () => {
  it('parses m:ss and h:mm:ss', () => {
    expect(parseLengthMs('6:12')).toBe(372_000)
    expect(parseLengthMs('1:02:03')).toBe(3_723_000)
  })

  it('parses seconds and passes through milliseconds', () => {
    expect(parseLengthMs('372')).toBe(372_000)
    expect(parseLengthMs('372000')).toBe(372_000)
  })

  it('returns null for blank and throws on garbage', () => {
    expect(parseLengthMs('')).toBeNull()
    expect(() => parseLengthMs('six minutes')).toThrow()
  })
})

describe('parseWantlistCsv', () => {
  it('imports rows via case-insensitive, order-free headers; ignores unknown columns', () => {
    const csv = 'Title,ARTIST,label,remix,Length\nAlive,Hot Since 82,Moda Black,,6:12\n'
    const result = parseWantlistCsv(csv)
    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([{
      artist: 'Hot Since 82', title: 'Alive', remix: null, lengthMs: 372_000, copyText: null,
    }])
  })

  it('reports per-line errors and keeps good rows', () => {
    const csv = 'artist,title,length\n,No Artist,3:00\nDaft Punk,One More Time,oops\nSolomun,Home,5:00\n'
    const result = parseWantlistCsv(csv)
    expect(result.errors).toHaveLength(2)
    expect(result.rows.map(r => r.title)).toEqual(['Home'])
  })

  it('rejects a file without the required headers', () => {
    const result = parseWantlistCsv('name,thing\nx,y\n')
    expect(result.rows).toEqual([])
    expect(result.errors[0]).toMatch(/artist.*title/)
  })

  it('maps copy_text (incl. "copy text" header spelling)', () => {
    const result = parseWantlistCsv('artist,title,copy text\nA,B,a b remix\n')
    expect(result.rows[0]?.copyText).toBe('a b remix')
  })
})
