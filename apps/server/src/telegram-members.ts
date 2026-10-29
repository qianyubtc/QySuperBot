import { ApiError } from './security.ts';
import type { Row } from './database.ts';

export type TelegramCall = (action: string, params?: unknown) => Promise<{ status: number; data: any }>;
export const mutePermissions = Object.fromEntries(
  [
    'can_send_messages',
    'can_send_audios',
    'can_send_documents',
    'can_send_photos',
    'can_send_videos',
    'can_send_video_notes',
    'can_send_voice_notes',
    'can_send_polls',
    'can_send_other_messages',
    'can_add_web_page_previews',
  ].map((k) => [k, false]),
);
export async function telegramMember(call: TelegramCall, chatId: string, userId: string) {
  try {
    const r = await call('getChatMember', { chat_id: chatId, user_id: userId });
    if (
      r.status !== 200 ||
      r.data?.ok !== true ||
      String(r.data.result?.user?.id) !== userId ||
      !['creator', 'administrator', 'member', 'restricted', 'left', 'kicked'].includes(r.data.result?.status)
    )
      throw Error();
    return r.data.result;
  } catch {
    throw new ApiError(502, 'TG_MEMBER_LOOKUP', '无法实时核对 Telegram 成员身份，未执行管理操作');
  }
}
export async function checkTelegramManagement(
  call: TelegramCall,
  account: Row,
  chatId: string,
  userId: string,
  action: string,
  actorId?: string,
) {
  const me = await call('getMe');
  if (me.status !== 200 || me.data?.ok !== true || String(me.data.result?.id) !== account.external_id)
    throw new ApiError(409, 'TG_IDENTITY_CHANGED', 'Telegram 机器人身份无法确认，请刷新连接');
  const restrict = ['mute', 'ban'].includes(action);
  const self = await telegramMember(call, chatId, account.external_id);
  if (
    !['creator', 'administrator'].includes(self.status) ||
    (restrict && self.status !== 'creator' && self.can_restrict_members !== true)
  )
    throw new ApiError(409, 'TG_BOT_PERMISSION', '机器人需要群管理员身份及对应的限制成员权限');
  if (actorId) {
    const actor = await telegramMember(call, chatId, actorId);
    if (
      !['creator', 'administrator'].includes(actor.status) ||
      (restrict && actor.status !== 'creator' && actor.can_restrict_members !== true)
    )
      throw new ApiError(403, 'TG_ACTOR_PERMISSION', '发送命令的成员没有对应的管理员权限');
  }
  const target = await telegramMember(call, chatId, userId);
  if (action === 'warnings' || action === 'clearwarnings') return target;
  if (
    userId === account.external_id ||
    userId === actorId ||
    target.user.is_bot === true ||
    ['creator', 'administrator'].includes(target.status)
  )
    throw new ApiError(409, 'TG_TARGET_PROTECTED', '不能对群主、管理员、机器人或命令发送者执行此操作');
  if (
    !['member', 'restricted'].includes(target.status) ||
    (target.status === 'restricted' && target.is_member !== true)
  )
    throw new ApiError(409, 'TG_TARGET_NOT_MEMBER', '目标当前不在群内，未执行操作');
  if (action === 'mute' && target.status === 'restricted')
    throw new ApiError(
      409,
      'TG_EXISTING_RESTRICTION',
      '目标已有成员限制，请先在 Telegram 核对，避免覆盖其他管理员的设置',
    );
  return target;
}
