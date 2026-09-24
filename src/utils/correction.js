// 知识纠错处置闭环：状态常量、权限判定与文案（均为纯函数，便于复用与测试）
// 工单流转：open 待认领 → claimed 修订中 → in_review 送审中 → resolved 已修正（终态）
// 驳回/撤回送审 → 回到 claimed 继续修订；异常退出：
// - 提交人在待认领阶段撤单（revoked 终态）；
// - 编辑者认领后认为问题不成立，可退回提交人（revoked 终态，需说明）；
// - 关联文档被删除 → 回到 open 并解除文档关联（异常自愈）。
import { ROLE, canEditContent, isGuestUser } from './permission'

// 纠错工单状态
export const CORRECTION = {
  OPEN: 'open', // 待认领：成员已提交错误并关联文档
  CLAIMED: 'claimed', // 修订中：编辑者已认领，核对/修订内容中
  IN_REVIEW: 'in_review', // 送审中：修订已随评审单送审，等待管理员审批
  RESOLVED: 'resolved', // 已修正：审批通过，修订已回写版本并随问答引用生效
  REVOKED: 'revoked' // 已撤回：提交人撤单 / 编辑者退回（异常退出，记录保留）
}

// 错误类型（提交时选择，便于统计与处理）
export const CORRECTION_TYPES = [
  { key: 'factual', label: '事实/数据错误' },
  { key: 'outdated', label: '内容过时' },
  { key: 'typo', label: '错别字/表述' },
  { key: 'broken', label: '链接/示例失效' },
  { key: 'other', label: '其它' }
]

export function correctionTypeLabel(key) {
  return (CORRECTION_TYPES.find((t) => t.key === key) || {}).label || key || '其它'
}

export function correctionStatusLabel(status) {
  return { open: '待认领', claimed: '修订中', in_review: '送审中', resolved: '已修正', revoked: '已撤回' }[status] || status
}

export function correctionStatusCls(status) {
  return { open: 'st-open', claimed: 'st-claimed', in_review: 'st-review', resolved: 'st-resolved', revoked: 'st-revoked' }[status] || ''
}

// 流转中（非终态）：待认领 / 修订中 / 送审中
export function isCorrectionOpen(ticket) {
  return !!ticket && [CORRECTION.OPEN, CORRECTION.CLAIMED, CORRECTION.IN_REVIEW].includes(ticket.status)
}

// 同一文档上是否已有流转中的纠错单（文档锁定/引用暂停/提交去重的判定依据）
export function hasOpenCorrection(ticket) {
  return isCorrectionOpen(ticket)
}

// 问答引用闸门：文档存在流转中纠错单时暂停引用（审批通过修订回写后恢复）。
// 已撤回单不再影响引用；未启用纠错流程的文档正常引用。
export function isCorrectionCitable(activeTicket) {
  return !isCorrectionOpen(activeTicket)
}

// 提交纠错：任何已登录成员（含只读角色）均可；访客不可（需要明确责任人与状态追踪）。
// 必须关联一篇文档。
export function canCreateCorrection(user) {
  return !!user && !isGuestUser(user?.id) && !!user.role
}

// 认领：编辑者/管理员，且工单处于待认领
export function canClaimCorrection(role, ticket) {
  return !!ticket && ticket.status === CORRECTION.OPEN && canEditContent(role)
}

// 是否为工单当前处理人（认领编辑者本人或管理员）
export function isCorrectionOwner(ticket, userId, role) {
  return !!ticket && (ticket.claimedBy === userId || role === ROLE.ADMIN)
}

// 取消认领：修订中、处理人本人（管理员也可），工单回到待认领
export function canReleaseCorrection(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED &&
    (ticket.claimedBy === userId || role === ROLE.ADMIN) && canEditContent(role)
}

// 关联修订送审：修订中、处理人、且为编辑内容角色（二次校验，与评审发起资格联动）
export function canSubmitCorrectionReview(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED &&
    (ticket.claimedBy === userId || role === ROLE.ADMIN) && canEditContent(role)
}

// 提交人撤单：仅待认领阶段可自行撤回（认领后请联系处理编辑者；送审中须先撤回评审）
export function canRevokeBySubmitter(ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.OPEN &&
    ticket.submittedBy === userId && !isGuestUser(userId)
}

// 编辑者退回（认为问题不成立/无需修订）：修订中阶段，处理人操作，需填写说明
export function canDismissByEditor(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED &&
    (ticket.claimedBy === userId || role === ROLE.ADMIN) && canEditContent(role)
}

// 纠错单处理记录的动作文案（timeline 全程保留，提交人可据此追踪状态）
export function correctionTimelineLabel(action) {
  return {
    create: '提交纠错',
    claim: '认领修订',
    release: '取消认领',
    submit: '修订送审',
    resolve: '审批通过 · 修订已发布',
    return: '评审驳回 · 退回修订',
    withdraw: '撤回送审 · 继续修订',
    revoke: '提交人撤单',
    dismiss: '编辑者退回 · 问题不成立',
    reset: '关联文档已删除 · 退回待认领'
  }[action] || action
}
