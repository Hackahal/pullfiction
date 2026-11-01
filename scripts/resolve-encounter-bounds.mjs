// Keep the Python audit on the same recorded-boundary implementation as imports.
import { resolveEncounterBounds } from '../web/planner/encounter-bounds.mjs';
let input='';
for await(const chunk of process.stdin)input+=chunk;
const {report,fights,boundaryEvents}=JSON.parse(input);
process.stdout.write(JSON.stringify(fights.map(f=>resolveEncounterBounds(report,f,boundaryEvents))));
