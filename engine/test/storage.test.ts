import { it,expect } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Contract } from '../../contract/src/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { fixture,ctx } from './helpers.js';
it('revalidates stored event payloads before replay',async()=>{
 const f=await fixture();try{
  await f.engine.command(ctx,{commandId:'one',type:'vc.CreateArtifact',payload:{title:'Test',mediaKind:'doc'}});await f.engine.stop();
  const db=new Database(join(f.dir,'workspace.sqlite'));
  try{db.prepare("UPDATE sys_events SET json=json_set(json, '$.payload', json('[]')) WHERE seq=1").run();}finally{db.close();}
  const store=new SqliteStore(join(f.dir,'workspace.sqlite'),new Contract());try{expect(()=>store.eventsAfter(0)).toThrow();}finally{store.close();}
 }finally{await f.close();}
});
