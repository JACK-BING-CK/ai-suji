import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// 只替换 App-Plus 回调桥；SQL、事务和落盘均交给真正的文件型 SQLite。
export function installBridge(file, beforeExecute = () => {}) {
  let db
  function callback(options, action) {
    try {
      options.success(action())
    } catch (error) {
      options.fail(error)
    }
  }
  globalThis.plus = {
    sqlite: {
      isOpenDatabase: () => Boolean(db),
      openDatabase(options) {
        callback(options, () => {
          assert.equal(options.path, '_doc/ai-suji.db')
          db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
        })
      },
      closeDatabase(options) {
        callback(options, () => {
          db.close()
          db = undefined
        })
      },
      executeSql(options) {
        callback(options, () => {
          for (const sql of [].concat(options.sql)) {
            beforeExecute(sql)
            db.exec(sql)
          }
        })
      },
      selectSql(options) {
        callback(options, () => db.prepare(options.sql).all())
      },
      transaction(options) {
        callback(options, () => db.exec(options.operation))
      },
    },
  }
  const offline = () => {
    throw new Error('离线测试禁止网络请求')
  }
  globalThis.uni = { request: offline }
  globalThis.fetch = offline
  return () => db
}
