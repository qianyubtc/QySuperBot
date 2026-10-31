import type { Row } from './database.ts';
import { epoch } from './context.ts';
import { groupEnabled } from './scope.ts';

export function policyAvailability(group: Row, account: Row, snapshot?: Row) {
  const requirements = {
    delete: ['messages.delete'],
    remove: ['messages.delete', 'members.remove'],
    ban: ['messages.delete', 'members.ban'],
    verification: ['messages.send'],
    verification_remove: ['messages.send', 'members.remove'],
    verification_mute: ['messages.send', 'members.mute'],
  };
  return Object.fromEntries(
    Object.entries(requirements).map(([action, required]) => {
      let reason: string | null = null;
      const supports = required.map((capability) =>
        snapshot?.capabilities?.find((item: Row) => item.capability === capability),
      );
      if (!snapshot) reason = '尚无群权限快照，请刷新权限';
      else if (supports.some((support) => !support || support.state === 'unsupported'))
        reason = '当前平台连接器尚未接入此动作';
      else if (supports.some((support) => support.state !== 'supported'))
        reason = '当前平台是否支持此动作尚未确认';
      else if (
        !account.is_demo &&
        (!Number.isFinite(epoch(snapshot.observed_at)) || epoch(snapshot.observed_at) < Date.now() - 300_000)
      )
        reason = '群权限快照已过期，请刷新权限';
      if (!reason)
        for (const capability of required) {
          const permission = snapshot?.permissions?.find((item: Row) => item.capability === capability);
          if (permission?.permission !== 'granted')
            reason =
              permission?.reason ||
              (permission?.permission === 'denied'
                ? '当前账号未获得此动作权限'
                : '当前账号权限尚未确认，请刷新权限');
          if (reason) break;
        }
      if (!reason && account.status !== 'online') reason = '账号未在线，请先恢复连接';
      if (!reason && !groupEnabled(account, group.external_id))
        reason = '此群已取消同步，请先在连接账号中重新勾选';
      if (account.kind === 'binance' && action.startsWith('verification'))
        reason = '币安入群验证及自动处罚尚未接入；成员管理仅开放后台手动操作';
      return [action, { available: !reason, reason }];
    }),
  );
}

// Keep decisions separate from real execution receipts, including older edits and
// partial successes. A successful delete never conceals an unknown member action.
export function moderationJobsSql(alias = 'm') {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',mj.id,'action',mj.action,'status',mj.status,'last_error',mj.last_error,
    'purpose',mj.review_ref->>'purpose','rule_name',mj.review_ref->>'rule_name',
    'content_version',mj.review_ref->>'content_version',
    'current_version',mj.review_ref->>'content_version'=${alias}.content_version::text)
    ORDER BY mj.created_at,mj.id)
    FROM jobs mj WHERE mj.conversation_id=${alias}.conversation_id
      AND mj.review_ref->>'purpose' IN ('moderation','keyword')
      AND mj.review_ref->>'message_record_id'=${alias}.id),'[]'::jsonb)`;
}
