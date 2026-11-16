import assert from 'node:assert/strict'
import { isHandOff } from '../src/pipeline-fastbrain.js'

// #323: the fast brain claiming it lacks the main agent's tools is a hand-off.
for (const s of [
  '[RESEARCH_NEEDED]', 'I have no browser access.', 'I have no live web browser.', "I'm not able to open the site.",
  'I am not able to run shell commands.', "I don't have the ability to take a screenshot.",
  "I don't have a way to take screenshots.", "I don't have the ability to open URLs.", "I don't have the ability to run commands.",
  "Sorry, can't open the site from here.", "I can't access the web.", 'I cannot take screenshots.', "I can't browse the web.", "I can't record video of the page.",
  'I cannot edit or build the project from here.', "I don't have access to the internet.",
  "I don't have any kind of direct, live, real-time access to a web browser.", 'I don\u2019t have a live web browser.',
]) assert.ok(isHandOff(s), `hand-off: ${s}`)
// Recall that mentions an inability stays an answer.
for (const s of [
  'I cannot find a screenshot in the session history.', "You said you can't open the site without logging in first.",
  'The log shows the error: cannot open page, connection refused.', 'Earlier you ran the build and it passed.',
  "I don't have any record of that in the session history.", "I don't know whether the build passed.",
  "I can't tell which web page you meant.", "I can't wait to open it.",
  'I have no record of the build failing.', "I don't have the run output in history.", "I can't confirm the build passed.",
  "I don't have details on which web page you opened.", 'I have no record of the terminal command you ran.',
  "I can't run through all of it, but the build passed.", 'I lack details about the bash script.',
  "I don't have the shell output from that run in history.", "I don't have the build log.", "I don't have a screenshot of that in history.",
]) assert.ok(!isHandOff(s), `answer: ${s}`)
console.log('pipeline fast-brain guard: all assertions passed')
