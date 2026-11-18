// Runs in a zone with US daylight saving, so the 23-hour day of 8 Mar 2026 falls inside the week.
process.env.TZ = 'America/New_York'
import assert from 'node:assert/strict'
import { dayBucket } from '../src/lib/outputs-model'

const wed = new Date(2026, 2, 11, 12).getTime()            // Wed 11 Mar 2026
assert.equal(dayBucket(new Date(2026, 2, 5, 12).getTime(), wed), 'thisWeek', 'Thu 5 Mar is six days back')
assert.equal(dayBucket(new Date(2026, 2, 4, 12).getTime(), wed), 'older', 'Wed 4 Mar is a week ago, not "This week"')
console.log('day-bucket-dst: ok')
