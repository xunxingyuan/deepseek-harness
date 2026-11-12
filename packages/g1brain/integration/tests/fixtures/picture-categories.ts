/** Resource-service category fixture shared by upload and real-Loader tests. */
interface Category {
  id: string
  parentId: string
  categoryName: string
  categoryType: string
}

/** Model the Web resource API's selected subtree and duplicate-name rejection.
 * @param userId - authenticated actor required on creation.
 * @returns independent server records and the two category endpoints.
 */
export function pictureCategories(userId = 'user-123') {
  const nodes: Category[] = [{ id: '11', parentId: '0', categoryName: '全部', categoryType: 'picture' }]
  let nextId = 100
  function tree(node: Category): object {
    return { ...node, childList: nodes.filter(child => child.parentId === node.id).map(tree) }
  }
  return { nodes,
    response(url: URL, method = 'GET'): unknown {
      if (!url.pathname.startsWith('/resManagementAPI/category/')) return undefined
      if (url.searchParams.get('categoryType') !== 'picture') throw new Error('Picture category type missing')
      if (url.pathname.endsWith('/list') && method === 'GET') {
        const root = nodes.find(node => node.id === url.searchParams.get('id'))
        if (!root) throw new Error('Category not found')
        return tree(root)
      }
      if (url.pathname.endsWith('/add') && method === 'POST') {
        const parentId = url.searchParams.get('parentId')
        const name = url.searchParams.get('name')
        if (url.searchParams.get('userId') !== userId || !parentId || !name || !nodes.some(node => node.id === parentId)) {
          throw new Error('Wrong category create scope')
        }
        if (nodes.some(node => node.parentId === parentId && node.categoryName === name)) throw new Error('Duplicate category')
        nodes.push({ id: String(nextId++), parentId, categoryName: name, categoryType: 'picture' })
        return true
      }
      throw new Error('Unexpected category endpoint')
    },
  }
}
