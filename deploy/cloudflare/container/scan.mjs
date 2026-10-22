// One scan, in a process of its own: the server can stop it when it runs too long, and it running out
// of memory takes only itself down. node container/scan.mjs <folder> <name> prints the city JSON.
import { scanRepo } from '../src/scan.mjs';

const [dir, name] = process.argv.slice(2);
const city = await scanRepo(dir, { name });
process.stdout.write(JSON.stringify(city));
