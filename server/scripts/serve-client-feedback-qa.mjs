if (!process.cwd().includes('qiji-client-feedback-')) throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('QA sandbox blocks outbound network');};
const {default:Fastify}=await import('fastify');const app=Fastify();
await app.register((await import('@fastify/cors')).default,{origin:true});
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
await app.register((await import('../src/routes/agent.ts')).registerAgentRoutes);
await app.listen({host:'127.0.0.1',port:8987});console.log('Isolated feedback QA at http://127.0.0.1:8987');
