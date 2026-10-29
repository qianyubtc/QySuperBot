import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshListMethod,
  freshMemberMethod,
  patchNapcatMembers,
} from '../../../scripts/patch-napcat-members.ts';

const Runtime = new Function(`return class { ${freshListMethod} ${freshMemberMethod} }`)();
test('forced member refresh waits for current data and cannot reuse a cached administrator role', async () => {
  const cache = new Map([['group', new Map([['uid', { role: 4 }]])]]);
  let complete!: (value: unknown) => void;
  let received = false;
  const runtime = new Runtime();
  runtime.core = {
    apis: {
      GroupApi: {
        groupMemberCache: cache,
        getGroupMemberAll: (group: string, forced: boolean) => {
          assert.equal(group, 'group');
          assert.equal(forced, true);
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
      },
    },
  };
  const pending = runtime.getGroupMembers('group', true).then((value: unknown) => {
    received = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(received, false);
  const fresh = new Map([['uid', { role: 2 }]]);
  complete({ errCode: 0, result: { infos: fresh } });
  assert.equal(await pending, fresh);
  assert.equal(cache.get('group')?.get('uid')?.role, 2);
});
test('failed, empty and malformed refreshes never authorize from an older member cache', async () => {
  for (const result of [
    { errCode: 1, result: { infos: new Map([['uid', { role: 4 }]]) } },
    { errCode: 0, result: { infos: new Map() } },
    {},
    { result: { infos: [] } },
  ]) {
    const old = new Map([['uid', { role: 4 }]]);
    const runtime = new Runtime();
    runtime.core = {
      apis: {
        GroupApi: { groupMemberCache: new Map([['group', old]]), getGroupMemberAll: async () => result },
      },
    };
    await assert.rejects(runtime.getGroupMembers('group', true), /fresh member list unavailable/);
    assert.equal(runtime.core.apis.GroupApi.groupMemberCache.get('group'), old);
  }
});
test('fresh single-member lookup verifies identity without waiting for unrelated profile data', async () => {
  const runtime = new Runtime();
  let member: any = { uid: 'uid', uin: '12345', role: 3, joinTime: '123456789', shutUpTime: 0 };
  runtime.core = {
    apis: {
      GroupApi: {
        getGroupMemberEx: async (group: string, uid: string, forced: boolean) => {
          assert.equal(group, '67890');
          assert.equal(uid, 'uid');
          assert.equal(forced, true);
          return member;
        },
      },
      UserApi: {
        getUserDetailInfo: () => {
          throw new Error('Profile lookup must not run');
        },
      },
    },
  };
  const request = { group_id: '67890', user_id: '12345' };
  assert.equal(await runtime.getGroupMemberInfo(request, 'uid', true), member);
  for (const invalid of [
    undefined,
    { ...member, uin: '99999' },
    { ...member, uid: 'someone-else' },
    { ...member, role: 0 },
  ]) {
    member = invalid;
    await assert.rejects(
      runtime.getGroupMemberInfo(request, 'uid', true),
      /fresh member identity unavailable/,
    );
    member = { uid: 'uid', uin: '12345', role: 2 };
  }
  assert.equal((await runtime.getGroupMemberInfo(request, 'uid', true)).role, 2);
});
test('deployment patch refuses bundles other than the verified installed NapCat version', () => {
  assert.throws(() => patchNapcatMembers('unrecognized code'), /unverified version/);
});
