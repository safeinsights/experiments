import { describe, expect, it } from 'vitest'
import { isFridayOff, parseDaysOff, renderReport, today, window, workdays } from './pr-report'

const PAGE = `- 2026-01-01 a bullet before any section is ignored

## Holidays
- 2026-11-26..2026-11-27 Thanksgiving
* 2026-12-25

## PTO
- @PhilSchatz 2026-12-21..2026-12-22, 2026-12-28 family
- alice: 2026-11-10
- 2026-11-11 a bullet without a login is ignored
`
const noDaysOff = parseDaysOff('')

describe('parseDaysOff', () => {
    it('reads holidays and per-login PTO, with ranges and comments', () => {
        const daysOff = parseDaysOff(PAGE)
        expect([...daysOff.holidays]).toEqual(['2026-11-26', '2026-11-27', '2026-12-25'])
        expect(Object.fromEntries([...daysOff.pto].map(([login, days]) => [login, [...days]]))).toEqual({
            philschatz: ['2026-12-21', '2026-12-22', '2026-12-28'],
            alice: ['2026-11-10'],
        })
    })
})

describe('the calendar', () => {
    it('takes today in Chicago and the 13 weeks before it', () => {
        expect(today(new Date('2026-11-23T03:00:00Z'))).toBe('2026-11-22')
        expect(window('2026-11-23')).toEqual({ start: '2026-08-24', end: '2026-11-22' })
    })

    it('has every other Friday off, either side of 2026-11-06', () => {
        expect(
            ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-20', '2026-12-04', '2026-12-05'].map(isFridayOff),
        ).toEqual([true, false, true, true, true, false])
    })
})

describe('workdays', () => {
    it('leaves out weekends and the two off-Fridays in four weeks', () => {
        expect(workdays('2026-10-26', '2026-11-22', noDaysOff, 'bob')).toBe(18)
    })

    it('leaves out holidays and that developer’s PTO, counting each day once', () => {
        const daysOff = parseDaysOff(PAGE)
        expect(workdays('2026-11-03', '2026-11-30', daysOff, 'bob')).toBe(16)
        expect(workdays('2026-11-03', '2026-11-30', daysOff, 'Alice')).toBe(15)
        daysOff.pto.get('alice')!.add('2026-11-06')
        expect(workdays('2026-11-03', '2026-11-30', daysOff, 'alice')).toBe(15)
    })
})

describe('renderReport', () => {
    it('lists those below the target first, lowest average first and without numbers, then those on target', () => {
        const report = renderReport(
            [
                { login: 'bob', prs: 15, workdays: 15 },
                { login: 'Alice', prs: 9, workdays: 16 },
                { login: 'carol', prs: 0, workdays: 0 },
                { login: 'dave', prs: 2, workdays: 16 },
            ],
            '2026-10-26',
            '2026-11-22',
        )
        expect(report).toContain('PRs opened per workday from 2026-10-26 to 2026-11-22')
        expect(report.split('\n').filter((line) => line.startsWith('- '))).toEqual([
            '- ⚪ dave',
            '- ⚪ Alice',
            '- ✅ bob',
            '- ✅ carol',
        ])
    })
})
