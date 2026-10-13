import { PhysicsRuntime } from './physics/runtime.js';
import { readFile } from 'node:fs/promises';
import { compile, validateIR } from './compiler.js';
import { capabilities } from './backends.js';
import { Runtime } from './runtime.js';
import { createAPI } from './api.js';
import { serveMCP } from './mcp.js';
import { simulateCircuit } from './verification.js';
import { z } from 'zod';
import { DesignSpecSchema } from './contracts.js';
const args = process.argv.slice(2),
  command = args[0];
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const runtime = new Runtime(option('--runs-dir'));
const print = (result: unknown) => console.log(JSON.stringify(result, null, 2));
try {
  if (command === 'physics') {
    const result = await new PhysicsRuntime(option('--runs-dir')).run(
      JSON.parse(await readFile(args[1], 'utf8')),
    );
    print(result);
    if (!['accepted', 'improved'].includes(result.status)) process.exitCode = 1;
  } else if (['compile', 'validate', 'design', 'simulate'].includes(command)) {
    const input = JSON.parse(await readFile(args[1], 'utf8'));
    if (command === 'compile') print(compile(input));
    else if (command === 'validate') print(validateIR(input));
    else if (command === 'simulate') {
      const result = await simulateCircuit(input);
      print(result);
      if (result.verification.status === 'failed') process.exitCode = 1;
    } else {
      const result = await runtime.run(input);
      print(result);
      if (result.status === 'failed') process.exitCode = 1;
    }
  } else if (command === 'verify') {
    const result = await runtime.verifyRun(args[1]);
    print(result);
    if (result.status === 'failed') process.exitCode = 1;
  } else if (command === 'capabilities') print(capabilities());
  else if (command === 'schema') print(z.toJSONSchema(DesignSpecSchema, { io: 'input' }));
  else if (command === 'mcp') await serveMCP(runtime);
  else if (command === 'serve') {
    const port = Number(option('--port', '8000')),
      host = option('--host', '127.0.0.1');
    const server = createAPI(runtime);
    server.listen(port, host, () =>
      console.error(
        `AgentPIC HTTP listening on http://${host}:${(server.address() as { port: number }).port}`,
      ),
    );
  } else {
    console.error(
      'Usage: agentpic physics GOAL; compile|validate|simulate|design FILE; verify RUN_ID; serve; mcp; capabilities; schema [--runs-dir DIR]',
    );
    process.exitCode = command === '--help' ? 0 : 2;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', error: String(error) }));
  process.exitCode = 2;
}
