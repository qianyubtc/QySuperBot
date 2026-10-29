import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// NapCat v4.18.41. Keep the upstream package intact and patch a separate release.
// https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-onebot/action/group/GetGroupMemberList.ts
export const napcatOriginalSha256 = '7c66d0239d7effe73ab6e4920eddef732a8066fb47cd19539541c72055c5f0aa';
export const freshListMethod = `async getGroupMembers(e, n) {
    const api = this.core.apis.GroupApi;
    let members = api.groupMemberCache.get(e);
    if (n || !members) {
      const result = await api.getGroupMemberAll(e, true);
      const fresh = result?.result?.infos;
      if ((result?.errCode !== undefined && result.errCode !== 0) || !(fresh instanceof Map) || !fresh.size)
        throw new Error("SUPERBOT_QQ_MEMBER_FRESH_V1: fresh member list unavailable");
      members = fresh;
      api.groupMemberCache.set(e, members);
    }
    return members;
  }`;
export const freshMemberMethod = `async getGroupMemberInfo(e, n, r) {
    if (r) {
      const member = await this.core.apis.GroupApi.getGroupMemberEx(e.group_id.toString(), n, true);
      if (!member || String(member.uin) !== String(e.user_id) ||
          (member.uid !== undefined && member.uid !== n) || ![2, 3, 4].includes(member.role))
        throw new Error("SUPERBOT_QQ_MEMBER_FRESH_V1: fresh member identity unavailable");
      return member;
    }
    const cached = this.core.apis.GroupApi.groupMemberCache.get(e.group_id.toString())?.get(n);
    const [member, profile] = await Promise.all([
      this.core.apis.GroupApi.getGroupMemberEx(e.group_id.toString(), n, false),
      this.core.apis.UserApi.getUserDetailInfo(n, false)
    ]);
    if (!member || !cached) throw new Error("group member unavailable");
    return profile ? { ...cached, ...member, ...profile } : member;
  }`;
const oldList = `async getGroupMembers(e, n) {
    const r = this.core.apis.GroupApi.groupMemberCache;
    let i = r.get(e);
    if (n || !i) {
      const o = this.core.apis.GroupApi.refreshGroupMemberCache(e, !0).then().catch();
      if (i = r.get(e) || await o, !i)
        throw new Error(\`Failed to get group member list for group \${e}\`);
    }
    return i;
  }`;
const oldMember = `async getGroupMemberInfo(e, n, r) {
    const o = this.core.apis.GroupApi.groupMemberCache.get(e.group_id.toString())?.get(n), [s, a] = await Promise.all([
      this.core.apis.GroupApi.getGroupMemberEx(e.group_id.toString(), n, r),
      this.core.apis.UserApi.getUserDetailInfo(n, r)
    ]);
    if (!s || !o) throw new Error(\`群(\${e.group_id})成员\${e.user_id}不存在\`);
    return a ? { ...o, ...s, ...a } : s;
  }`;
export function patchNapcatMembers(source: string) {
  if (createHash('sha256').update(source).digest('hex') !== napcatOriginalSha256)
    throw new Error('Unsupported NapCat bundle; refusing to patch an unverified version');
  for (const old of [oldList, oldMember]) {
    if (source.split(old).length !== 2) throw new Error('NapCat patch location is ambiguous');
  }
  return source.replace(oldList, freshListMethod).replace(oldMember, freshMemberMethod);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output)
    throw new Error('Usage: node patch-napcat-members.ts INPUT OUTPUT');
  writeFileSync(output, patchNapcatMembers(readFileSync(input, 'utf8')), { flag: 'wx', mode: 0o644 });
  console.log('Patched verified NapCat member lookups; original bundle preserved.');
}
