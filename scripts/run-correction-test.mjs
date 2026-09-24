// 知识纠错处置闭环：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:correction（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useCorrectionStore } from '@/stores/correction'
import { useReviewStore } from '@/stores/review'
import { useKbStore } from '@/stores/kb'
import { CORRECTION } from '@/utils/correction'
import { REVIEW, PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const correction = useCorrectionStore(pinia)
const review = useReviewStore(pinia)
const kb = useKbStore(pinia)

const viewer = { id: 'u-view', role: 'viewer', name: '成员甲' }
const viewer2 = { id: 'u-view2', role: 'viewer', name: '成员乙' }
const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const otherEditor = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const guest = { id: 'u-guest', role: null, name: '访客' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

async function mkDoc(ownerId, extra = {}) {
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title: extra.title || '鉴权文档',
    body: '<p>旧内容：Token 有效期 7 天</p>',
    categoryId: 'c-dev', tagIds: [],
    visibility: 'public', ownerId, editors: [ownerId],
    publishState: PUBLISH.PUBLISHED,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    versions: [{ version: 1, savedAt: new Date().toISOString(), savedBy: ownerId, note: '初始', snapshot: { title: extra.title || '鉴权文档', body: '<p>旧内容：Token 有效期 7 天</p>', categoryId: 'c-dev', tagIds: [], visibility: 'public' } }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}

// ---------- 1. 提交纠错：成员关联文档，状态待认领 ----------
console.log('\n[1] 成员提交纠错并关联文档 → open，问答引用闸门暂停')
const doc1 = await mkDoc(editor.id, { title: '文档一' })
let r = await correction.createTicket({ docId: doc1.id, type: 'factual', summary: 'Token 有效期写错了', detail: '应为 30 分钟' }, viewer)
assert(r.status === 'ok', '纠错提交成功')
const tk1 = r.ticket
assert(tk1.status === CORRECTION.OPEN, '初始状态为待认领')
assert(tk1.submittedBy === viewer.id, '记录提交人')
assert(!!correction.activeTicketOfDoc(doc1.id), 'activeTicketOfDoc 命中（问答引用应暂停）')

// 访客不可提交
const docG = await mkDoc(editor.id, { title: '文档G' })
r = await correction.createTicket({ docId: docG.id, summary: 'x' }, guest)
assert(r.status === 'guest', '访客不能提交纠错')

// 同文档去重
r = await correction.createTicket({ docId: doc1.id, summary: '又一条' }, viewer2)
assert(r.status === 'duplicate', '同一文档流转中纠错单去重')

// ---------- 2. 提交人撤单（异常退出）----------
console.log('\n[2] 提交人待认领阶段撤单 → revoked，引用闸门解除')
r = await correction.revokeBySubmitter(tk1.id, '我看错了', viewer)
assert(r.status === 'ok', '提交人撤单成功')
await correction.reload()
const revoked1 = await db.correctionTickets.get(tk1.id)
assert(revoked1.status === CORRECTION.REVOKED, '工单已撤回')
assert(!correction.activeTicketOfDoc(doc1.id), '撤单后引用闸门解除')
// 他人不能撤单
const doc2 = await mkDoc(editor.id, { title: '文档二' })
r = await correction.createTicket({ docId: doc2.id, type: 'typo', summary: '错别字' }, viewer)
const tk2 = r.ticket
r = await correction.revokeBySubmitter(tk2.id, '', viewer2)
assert(r.status === 'denied', '非提交人不能撤单')

// ---------- 3. 编辑者认领 + 取消认领 ----------
console.log('\n[3] 编辑者认领 → claimed；只读成员不可认领；可取消认领退回')
r = await correction.claimTicket(tk2.id, viewer)
assert(r.status === 'denied', '只读成员不能认领')
r = await correction.claimTicket(tk2.id, editor)
assert(r.status === 'ok', '编辑者认领成功')
await correction.reload()
let cur = await db.correctionTickets.get(tk2.id)
assert(cur.status === CORRECTION.CLAIMED && cur.claimedBy === editor.id, '进入修订中并记录处理人')
r = await correction.releaseTicket(tk2.id, editor)
assert(r.status === 'ok', '取消认领成功')
await correction.reload()
cur = await db.correctionTickets.get(tk2.id)
assert(cur.status === CORRECTION.OPEN && !cur.claimedBy, '退回待认领')

// ---------- 4. 完整闭环：认领 → 修订送审 → 管理员审批 → 回写版本、恢复引用 ----------
console.log('\n[4] 认领 → 修订送审 → 审批通过：回写版本、工单已修正、引用恢复')
await correction.claimTicket(tk2.id, editor)
await correction.reload()
const newBody = '<p>正确内容：Token 有效期 30 分钟</p>'
const doc2Fresh = await db.docs.get(doc2.id)
r = await review.submitCorrectionReview(tk2.id, {
  title: doc2Fresh.title, body: newBody, categoryId: doc2Fresh.categoryId,
  tagIds: [], visibility: doc2Fresh.visibility
}, '已按安全基线修正', editor)
assert(r.status === 'ok', '修订送审成功')
await correction.reload()
cur = await db.correctionTickets.get(tk2.id)
assert(cur.status === CORRECTION.IN_REVIEW && !!cur.reviewId, '工单进入送审中并关联评审单')
const lockedDoc = await db.docs.get(doc2.id)
assert(lockedDoc.publishState === PUBLISH.IN_REVIEW, '文档锁定为评审中，旧内容仍可见')
assert(!!correction.activeTicketOfDoc(doc2.id), '送审期间问答引用继续暂停')

// 非管理员不能审批
r = await review.decideReview(cur.reviewId, 'approve', '', editor)
assert(r.status === 'denied', '编辑者不能审批')
// 管理员通过
r = await review.decideReview(cur.reviewId, 'approve', '核实无误', admin)
assert(r.status === 'ok' && r.approved, '管理员审批通过')
await correction.reload()
cur = await db.correctionTickets.get(tk2.id)
assert(cur.status === CORRECTION.RESOLVED, '工单已修正')
assert(cur.resolvedVersion === 2, '回写版本号为 v2')
const finalDoc = await db.docs.get(doc2.id)
assert(finalDoc.body === newBody, '修订快照已回写正文')
assert(finalDoc.publishState === PUBLISH.PUBLISHED, '文档解除评审锁定')
assert(finalDoc.versions.length === 2 && finalDoc.versions[1].correctionReview, '追加带纠错标记的新版本')
assert(!correction.activeTicketOfDoc(doc2.id), '审批通过后问答引用恢复')

// ---------- 5. 驳回 → 退回修订 → 重新送审通过 ----------
console.log('\n[5] 审批驳回 → 退回 claimed → 修订后重新送审通过')
const doc3 = await mkDoc(editor.id, { title: '文档三' })
r = await correction.createTicket({ docId: doc3.id, summary: '链接失效' }, viewer)
const tk3 = r.ticket
await correction.claimTicket(tk3.id, editor)
let d3 = await db.docs.get(doc3.id)
r = await review.submitCorrectionReview(tk3.id, { title: d3.title, body: '<p>修订A</p>', categoryId: d3.categoryId, tagIds: [], visibility: d3.visibility }, '', editor)
assert(r.status === 'ok', '第一次送审成功')
await correction.reload()
let tk3fresh = await db.correctionTickets.get(tk3.id)
r = await review.decideReview(tk3fresh.reviewId, 'reject', '修订不完整', admin)
assert(r.status === 'ok' && !r.approved, '管理员驳回')
await correction.reload()
tk3fresh = await db.correctionTickets.get(tk3.id)
assert(tk3fresh.status === CORRECTION.CLAIMED && !tk3fresh.reviewId, '驳回后退回修订中并解除评审关联')
d3 = await db.docs.get(doc3.id)
assert(d3.body !== '<p>修订A</p>', '驳回不回写正文')
// 重新送审并通过
r = await review.submitCorrectionReview(tk3.id, { title: d3.title, body: '<p>修订B-完整</p>', categoryId: d3.categoryId, tagIds: [], visibility: d3.visibility }, '补充完整', editor)
assert(r.status === 'ok', '修订后可重新送审')
await correction.reload()
tk3fresh = await db.correctionTickets.get(tk3.id)
r = await review.decideReview(tk3fresh.reviewId, 'approve', '', admin)
assert(r.status === 'ok', '重新送审后审批通过')
await correction.reload()
tk3fresh = await db.correctionTickets.get(tk3.id)
assert(tk3fresh.status === CORRECTION.RESOLVED, '重新送审通过后工单已修正')

// ---------- 6. 撤回送审（异常）→ 回修订中 ----------
console.log('\n[6] 发起人撤回送审 → 工单回修订中，文档解锁')
const doc4 = await mkDoc(editor.id, { title: '文档四' })
r = await correction.createTicket({ docId: doc4.id, summary: '数据过时' }, viewer)
const tk4 = r.ticket
await correction.claimTicket(tk4.id, editor)
let d4 = await db.docs.get(doc4.id)
r = await review.submitCorrectionReview(tk4.id, { title: d4.title, body: '<p>修订X</p>', categoryId: d4.categoryId, tagIds: [], visibility: d4.visibility }, '', editor)
assert(r.status === 'ok', '送审成功')
await correction.reload()
const tk4fresh = await db.correctionTickets.get(tk4.id)
r = await review.withdrawReview(tk4fresh.reviewId, editor)
assert(r.status === 'ok', '发起人撤回评审成功')
await correction.reload()
const tk4back = await db.correctionTickets.get(tk4.id)
assert(tk4back.status === CORRECTION.CLAIMED && !tk4back.reviewId, '撤回后工单回修订中')
const d4back = await db.docs.get(doc4.id)
assert(d4back.publishState === PUBLISH.PUBLISHED, '撤回后文档解锁')

// ---------- 7. 编辑者退回（问题不成立）----------
console.log('\n[7] 编辑者认领后退回（问题不成立）→ revoked')
const doc5 = await mkDoc(editor.id, { title: '文档五' })
r = await correction.createTicket({ docId: doc5.id, summary: '疑似错误' }, viewer)
const tk5 = r.ticket
await correction.claimTicket(tk5.id, editor)
r = await correction.dismissByEditor(tk5.id, '', editor)
assert(r.status === 'ok', '退回（空说明也允许 store 层，UI 层强制必填）')
await correction.reload()
const tk5rev = await db.correctionTickets.get(tk5.id)
assert(tk5rev.status === CORRECTION.REVOKED && tk5rev.decidedBy === editor.id, '工单退回关闭并记录处理人')
assert(!correction.activeTicketOfDoc(doc5.id), '退回后引用闸门解除')

// ---------- 8. 文档删除 → 关联纠错单自动关闭 ----------
console.log('\n[8] 删除关联文档 → 流转中纠错单自动关闭（revoked）')
const doc6 = await mkDoc(admin.id, { title: '文档六' })
r = await correction.createTicket({ docId: doc6.id, summary: '送审中删文档' }, viewer)
const tk6 = r.ticket
await correction.claimTicket(tk6.id, admin)
const d6 = await db.docs.get(doc6.id)
await review.submitCorrectionReview(tk6.id, { title: d6.title, body: '<p>p</p>', categoryId: d6.categoryId, tagIds: [], visibility: d6.visibility }, '', admin)
await correction.reload()
r = await kb.deleteDoc(doc6.id, admin)
assert(r.status === 'ok', '删除文档成功')
await correction.reload()
const tk6closed = await db.correctionTickets.get(tk6.id)
assert(tk6closed.status === CORRECTION.REVOKED && !!tk6closed.closeNote, '送审中纠错单随文档删除自动关闭')

// ---------- 9. 无文档关系的编辑者不能送审他人文档 ----------
console.log('\n[9] 角色级越权防护：无关编辑者认领后不能送审他人文档')
const doc7 = await mkDoc(editor.id, { title: '文档七' }) // 拥有者 editor
r = await correction.createTicket({ docId: doc7.id, summary: '越权测试' }, viewer)
const tk7 = r.ticket
r = await correction.claimTicket(tk7.id, otherEditor)
assert(r.status === 'ok', '其他编辑者可认领工单')
const d7 = await db.docs.get(doc7.id)
r = await review.submitCorrectionReview(tk7.id, { title: d7.title, body: '<p>hacked</p>', categoryId: d7.categoryId, tagIds: [], visibility: d7.visibility }, '', otherEditor)
assert(r.status === 'denied', '与文档无关的编辑者不能借纠错送审改写他人文档')

console.log('\n==============================')
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
