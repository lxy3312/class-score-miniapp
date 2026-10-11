/*
 * 统一统计层自测（无 npm 依赖）。
 * 运行：node tests/score.js
 *
 * 测试通过 createScoreService 注入内存数据，不触碰云数据库，也不改变生产
 * API。每次调用统计函数都从 source 当前数组读取，用来验证修改/删除后不会
 * 留下旧的统计缓存。
 */

const assert = require('assert')
const score = require('../services/score.js')

function makeSource() {
  return {
    config: {
      currentTermId: 'term-1',
      terms: [{ id: 'term-1', name: '第一学期', start_date: '2026-09-01', end_date: '2027-01-31' }],
      settings: {
        badges: {
          enabled: true,
          rules: [
            { rank: 1, icon: 'A', label: '第一名' },
            { rank: 2, icon: 'B', label: '第二名' }
          ]
        }
      }
    },
    members: [
      { id: 1, name: '赵一', group_id: 'g1', group_name: '一组' },
      { id: 2, name: '李二', group_id: 'g1', group_name: '一组' },
      { id: 3, name: '王三', group_id: 'g2', group_name: '二组' },
      { id: 4, name: '陈四', group_id: 'g2', group_name: '二组' }
    ],
    events: [
      // 2026-09-07 是周一；下面两条用于同分稳定排序。
      { id: 'r1', student_id: 1, category: 'study', points: 10, created_at: '2026-09-07T09:00:00', term_id: 'term-1', note: 'a' },
      { id: 'r2', student_id: 2, category: 'sports', points: 8, created_at: '2026-09-07T10:00:00', term_id: 'term-1', note: 'b' },
      { id: 'r3', student_id: 3, category: 'labor', points: 8, created_at: '2026-09-07T11:00:00', term_id: 'term-1', note: 'c' },
      { id: 'r4', student_id: 4, category: 'discipline', points: 2, created_at: '2026-09-07T12:00:00', term_id: 'term-1', note: 'd' },
      { id: 'r5', student_id: 1, category: 'study', points: 3, created_at: '2026-09-14T09:00:00', term_id: 'term-1', note: 'next week' },
      { id: 'bad', student_id: 1, category: 'other', points: 999, created_at: '2026-09-07T13:00:00', term_id: 'term-1' },
      { id: 'void', student_id: 1, category: 'study', points: 100, created_at: '2026-09-07T14:00:00', term_id: 'term-1', voided: true }
    ]
  }
}

function findById(list, id) {
  return list.find(item => String(item.id) === String(id))
}

function run() {
  const source = makeSource()
  const service = score.createScoreService(source)
  const week = service.getWeekStats('2026-09-07')
  const term = service.getTermStats('term-1')

  // 1. 同分竞争排名 1,2,2,4，且同分姓名排序稳定。
  assert.deepStrictEqual(week.ranking.map(item => item.rank), [1, 2, 2, 4])
  assert.deepStrictEqual(week.ranking.map(item => item.name), ['赵一', '李二', '王三', '陈四'])
  assert.strictEqual(week.ranking[1].name, '李二')
  assert.strictEqual(week.ranking[2].name, '王三')
  assert.strictEqual(findById(week.rankings.sports, 2).score, 8)
  assert.strictEqual(findById(week.rankings.sports, 1).score, 0)

  // 2. 零积分学生保留并参与排名。
  assert.strictEqual(findById(week.ranking, 4).total, 2)
  source.events = source.events.filter(event => event.id !== 'r4')
  const zeroWeek = service.getWeekStats('2026-09-07')
  assert.ok(findById(zeroWeek.ranking, 4))
  assert.strictEqual(findById(zeroWeek.ranking, 4).total, 0)

  // 3. 非法 category 不得进入任何统计。
  assert.strictEqual(zeroWeek.total, 26) // 10 + 8 + 8，void/other/removed excluded
  assert.strictEqual(zeroWeek.eventCount, 3)
  assert.strictEqual(zeroWeek.categoryTotals.study, 10)

  // 4. 小组积分等于成员原始记录之和，零分组也保留。
  const groupOne = findById(zeroWeek.groups, 'g1')
  const groupTwo = findById(zeroWeek.groups, 'g2')
  assert.strictEqual(groupOne.total, 18)
  assert.strictEqual(groupTwo.total, 8)
  assert.strictEqual(groupOne.memberCount, 2)
  assert.strictEqual(zeroWeek.total, zeroWeek.groups.reduce((sum, group) => sum + group.total, 0))

  // 5. 学期总分等于该学期所有有效周记录累计。
  const weekTwo = service.getWeekStats('2026-09-14')
  const termAfterRemoval = service.getTermStats('term-1')
  const firstWeekTotal = zeroWeek.total
  assert.strictEqual(termAfterRemoval.total, firstWeekTotal + weekTwo.total)
  assert.strictEqual(termAfterRemoval.total, termAfterRemoval.weeks.reduce((sum, item) => sum + item.total, 0))

  // 6. 修改一条原始记录后，周榜、学期榜、个人页立即同步（无缓存）。
  const target = source.events.find(event => event.id === 'r2')
  target.points = 20
  const changedWeek = service.getWeekStats('2026-09-07')
  const changedTerm = service.getTermStats('term-1')
  const changedStudent = service.getStudentStats(2, { date: '2026-09-07', termId: 'term-1' })
  assert.strictEqual(findById(changedWeek.ranking, 2).total, 20)
  assert.strictEqual(findById(changedTerm.ranking, 2).term, undefined)
  assert.strictEqual(findById(changedTerm.ranking, 2).total, 20)
  assert.strictEqual(changedStudent.weekTotal, 20)
  assert.strictEqual(changedStudent.termTotal, 20)

  // 7. 删除一条记录后，周榜、学期榜、个人页立即同步。
  source.events = source.events.filter(event => event.id !== 'r2')
  const deletedWeek = service.getWeekStats('2026-09-07')
  const deletedTerm = service.getTermStats('term-1')
  const deletedStudent = service.getStudentStats(2, { date: '2026-09-07', termId: 'term-1' })
  assert.strictEqual(findById(deletedWeek.ranking, 2).total, 0)
  assert.strictEqual(findById(deletedTerm.ranking, 2).total, 0)
  assert.strictEqual(deletedStudent.weekTotal, 0)
  assert.strictEqual(deletedStudent.termTotal, 0)

  // 8. 关闭徽章后只剩数字排名，不返回徽章对象。
  source.config.settings.badges.enabled = false
  const noBadge = service.getWeekStats('2026-09-07')
  assert.strictEqual(noBadge.badgesEnabled, false)
  noBadge.ranking.forEach(item => assert.strictEqual(item.badge, null))
  source.config.settings = {}
  source.config.badges = { enabled: true, rules: [{ rank: 1, icon: 'TOP', label: '可配置徽章' }] }
  const topLevelBadge = service.getWeekStats('2026-09-07')
  assert.strictEqual(topLevelBadge.ranking[0].badge.icon, 'TOP')
  source.config.badges = undefined
  source.config.settings = { enabled: true, rules: [{ rank: 1, icon: 'ROOT', label: '设置根徽章' }] }
  const rootSettingsBadge = service.getWeekStats('2026-09-07')
  assert.strictEqual(rootSettingsBadge.ranking[0].badge.icon, 'ROOT')

  // 9. 中途加入的学生（无记录）正常显示。
  source.members.push({ id: 5, name: '新同学', group_id: 'g3', group_name: '三组', joined_at: '2026-09-10' })
  const afterJoin = service.getWeekStats('2026-09-07')
  assert.ok(findById(afterJoin.ranking, 5))
  assert.strictEqual(findById(afterJoin.ranking, 5).total, 0)

  // 10. 四维度始终完整，即使某个维度没有记录。
  assert.deepStrictEqual(Object.keys(findById(afterJoin.ranking, 5).categories).sort(), ['discipline', 'labor', 'sports', 'study'])

  // 11. 全班零积分不崩溃，所有人仍参与竞争排名。
  const allZeroSource = makeSource()
  allZeroSource.events = []
  const allZero = score.createScoreService(allZeroSource).getWeekStats('2026-09-07')
  assert.strictEqual(allZero.total, 0)
  assert.strictEqual(allZero.ranking.length, 4)
  assert.deepStrictEqual(allZero.ranking.map(item => item.rank), [1, 1, 1, 1])
  assert.ok(allZero.groups.every(group => group.total === 0))

  // 12. 空名单也应返回结构完整的零值结果，不因没有学生/小组而崩溃。
  const emptyClass = score.createScoreService({ config: {}, members: [], groups: [], events: [] }).getWeekStats('2026-09-07')
  assert.strictEqual(emptyClass.total, 0)
  assert.strictEqual(emptyClass.memberCount, 0)
  assert.strictEqual(emptyClass.groupCount, 0)
  assert.deepStrictEqual(emptyClass.ranking, [])
  assert.deepStrictEqual(emptyClass.groups, [])

  // 13. 周边界为本地周一 00:00（含）到下周一 00:00（不含）。
  const boundarySource = {
    config: {},
    members: [{ id: 1, name: '边界同学', group: '一组' }],
    events: [
      { id: 'start', student_id: 1, category: 'study', points: 1, created_at: '2026-09-07T00:00:00' },
      { id: 'sunday', student_id: 1, category: 'study', points: 2, created_at: '2026-09-13T23:59:59.999' },
      { id: 'next', student_id: 1, category: 'study', points: 4, created_at: '2026-09-14T00:00:00' }
    ]
  }
  const boundaryWeek = score.createScoreService(boundarySource).getWeekStats('2026-09-10')
  assert.strictEqual(boundaryWeek.total, 3)
  assert.strictEqual(boundaryWeek.range.startDate, '2026-09-07')
  assert.strictEqual(boundaryWeek.range.endDate, '2026-09-13')

  // 14. camelCase 旧字段与 snake_case 规范字段使用同一统计口径。
  const camelSource = {
    config: { currentTermId: 'term-1' },
    groups: [{ id: 'g1', name: '一组' }],
    members: [{ _id: 's1', name: '兼容同学', groupId: 'g1' }],
    events: [{ _id: 'c1', studentId: 's1', category: 'sports', delta: -3, occurredAt: '2026-09-07T08:00:00', termId: 'term-1' }]
  }
  const camelService = score.createScoreService(camelSource)
  assert.strictEqual(camelService.getWeekStats('2026-09-07').total, -3)
  assert.strictEqual(camelService.getTermStats('term-1').total, -3)
  assert.strictEqual(camelService.getWeekStats('2026-09-07').groups[0].name, '一组')

  // 15. CloudBase 旧文档同时带 _id 与逻辑 student_id 时，必须按逻辑 ID 对账。
  const mixedSource = {
    config: {},
    members: [{ _id: 'cloud-student-doc', student_id: 7, name: '逻辑编号同学', group_id: 'g1' }],
    events: [{ _id: 'mixed-record', student_id: 7, category: 'study', points: 6, created_at: '2026-09-07T09:00:00' }]
  }
  const mixed = score.createScoreService(mixedSource).getWeekStats('2026-09-07')
  assert.strictEqual(mixed.ranking[0].id, 7)
  assert.strictEqual(mixed.ranking[0].total, 6)

  const mixedGroupSource = {
    config: {},
    groups: [{ _id: 'cloud-group-doc', group_id: 'g7', name: '七组' }],
    members: [{ id: 8, name: '小组同学', group_id: 'g7' }],
    events: [{ id: 'group-record', student_id: 8, category: 'labor', points: 2, created_at: '2026-09-07T09:00:00' }]
  }
  const mixedGroup = score.createScoreService(mixedGroupSource).getWeekStats('2026-09-07')
  assert.strictEqual(mixedGroup.groups.length, 1)
  assert.strictEqual(mixedGroup.groups[0].id, 'g7')
  assert.strictEqual(mixedGroup.groups[0].total, 2)

  return true
}

if (require.main === module) {
  try {
    run()
    console.log('PASS score statistics self-test')
  } catch (error) {
    console.error('FAIL score statistics self-test')
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

module.exports = { run, makeSource }
