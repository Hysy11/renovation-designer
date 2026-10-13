// 对象编号（方案 6.9 节）：类型前缀 + 随机串前 8 位，并检查不重复。
// crypto.randomUUID 在浏览器和 Node 中都可用（全局 Web Crypto），不属于 DOM 对象。

export type IdPrefix = 'r_' | 'o_' | 'f_' | 'v_';

export type GenId = (prefix: IdPrefix, taken: ReadonlySet<string>) => string;

export const randomId: GenId = (prefix, taken) => {
  for (;;) {
    const id = prefix + globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    if (!taken.has(id)) return id;
  }
};

/** 测试用：按顺序生成 r_1、r_2…，结果可预测 */
export function sequentialIds(): GenId {
  let n = 0;
  return (prefix, taken) => {
    let id: string;
    do id = `${prefix}${++n}`;
    while (taken.has(id));
    return id;
  };
}
