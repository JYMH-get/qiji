import { describe, expect, it } from 'vitest';
import { selectedReasoningParams } from './textReasoningParams';
import type { ParamField } from '@/contract';

const fields: ParamField[] = [
  {key:'thinkingMode',label:'思考模式',type:'enum',options:['default','enabled']},
  {key:'reasoning_effort',label:'思考强度',type:'enum',options:['default','low','high']},
];
describe('text reasoning selection', () => {
  it('resolves concrete configured selections without upstream-default sentinel', () => {
    expect(selectedReasoningParams(fields.map(f=>({...f,default:'high'})))).toEqual({thinkingMode:'enabled',reasoning_effort:'high'});
  });
  it('drops stale settings no longer offered by a model without changing the saved selection', () => {
    const saved=Object.freeze({thinkingMode:'disabled',reasoning_effort:'max',prompt:'untouched'});
    expect(selectedReasoningParams(fields,saved)).toEqual({thinkingMode:'enabled',reasoning_effort:'high'});
    expect(saved.reasoning_effort).toBe('max');
  });
  it('replaces old upstream-default selections with concrete options', () => {
    expect(selectedReasoningParams(fields,{thinkingMode:'default',reasoning_effort:'low'})).toEqual({thinkingMode:'enabled',reasoning_effort:'low'});
  });
});
