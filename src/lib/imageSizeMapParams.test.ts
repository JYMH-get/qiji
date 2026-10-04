import {describe,it,expect} from 'vitest';
import {validateImageSizeMap} from '../../server/src/imageSizes';
describe('model-specific image mapping',()=>{
 it('retains Seedream fractional resolution and additional ratios',()=>{
  expect(validateImageSizeMap({'3:2':{'1.5k':'1872x1248'},'2:3':{'2k':'1664x2496'}})).toEqual({'3:2':{'1.5k':'1872x1248'},'2:3':{'2k':'1664x2496'}});
 });
 it('rejects prototype keys and invalid dimensions',()=>{
  expect(()=>validateImageSizeMap(JSON.parse('{"__proto__":{"2k":"2048x2048"}}'))).toThrow();
  expect(()=>validateImageSizeMap({'1:1':{'1.5k':'0x2048'}})).toThrow();
 });
});
