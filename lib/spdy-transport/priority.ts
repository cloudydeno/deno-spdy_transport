import { assert } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { binaryInsert, binarySearch } from './utils.ts'

function compareChildren (a: PriorityNode, b: PriorityNode) {
  return a.weight === b.weight ? a.id - b.id : a.weight - b.weight
}

export type PriorityJson = {
  parent?: number;
  weight: number;
  exclusive?: boolean;
}

type PriorityNodeOptions = {
  id: number;
  parent: null | PriorityNode;
  exclusive?: boolean;
  weight: number;
};

export class PriorityNode {
  tree: PriorityTree;
  id: number;
  parent: PriorityNode|null;
  weight: number;
  priorityFrom: number;
  priorityTo: number;
  priority: number;
  exclusive?: boolean;
  children: { list: PriorityNode[]; weight: number; };

  constructor(tree: PriorityTree, options: PriorityNodeOptions) {
    this.tree = tree

    this.id = options.id
    this.parent = options.parent
    this.weight = options.weight

    // To be calculated in `addChild`
    this.priorityFrom = 0
    this.priorityTo = 1
    this.priority = 1

    this.children = {
      list: [],
      weight: 0
    }

    if (this.parent !== null) {
      this.parent.addChild(this)
    }
  }

  toJSON(): PriorityJson {
    return {
      parent: this.parent?.id,
      weight: this.weight,
      exclusive: this.exclusive
    }
  }

  getPriority () {
    return this.priority
  }

  getPriorityRange () {
    return { from: this.priorityFrom, to: this.priorityTo }
  }

  addChild (child: PriorityNode) {
    child.parent = this
    binaryInsert(this.children.list, child, compareChildren)
    this.children.weight += child.weight

    this._updatePriority(this.priorityFrom, this.priorityTo)
  }

  remove () {
    assert(this.parent, 'Can\'t remove root node')

    this.parent.removeChild(this)
    this.tree._removeNode(this)

    // Move all children to the parent
    for (var i = 0; i < this.children.list.length; i++) {
      this.parent.addChild(this.children.list[i])
    }
  }

  removeChild (child: PriorityNode) {
    this.children.weight -= child.weight
    var index = binarySearch(this.children.list, child, compareChildren)
    if (index !== -1 && this.children.list.length >= index) {
      this.children.list.splice(index, 1)
    }
  }

  removeChildren () {
    var children = this.children.list
    this.children.list = []
    this.children.weight = 0
    return children
  }

  _updatePriority (from: number, to: number) {
    this.priority = to - from
    this.priorityFrom = from
    this.priorityTo = to

    var weight = 0
    for (var i = 0; i < this.children.list.length; i++) {
      var node = this.children.list[i]
      var nextWeight = weight + node.weight

      node._updatePriority(
        from + this.priority * (weight / this.children.weight),
        from + this.priority * (nextWeight / this.children.weight)
      )
      weight = nextWeight
    }
  }
}

type PriorityTreeOptions = {
  defaultWeight?: number;
  maxCount: number;
}

export class PriorityTree {
  map: Record<string,PriorityNode>;
  list: PriorityNode[];
  defaultWeight: number;
  count: number;
  maxCount: number;
  root: PriorityNode;

  constructor (options: PriorityTreeOptions) {
    this.map = {}
    this.list = []
    this.defaultWeight = options.defaultWeight || 16

    this.count = 0
    this.maxCount = options.maxCount

    // Root
    this.root = this.add({
      id: 0,
      parent: null,
      weight: 1
    })
  }

  static create (options: PriorityTreeOptions) {
    return new PriorityTree(options)
  }

  add (options: {
    id: number;
    parent?: null | number;
    exclusive?: boolean;
    weight: number;
  }): PriorityNode {
    if (options.id === options.parent) {
      return this.addDefault(options.id)
    }

    var parent = options.parent == null ? null : this.map[options.parent]
    if (parent === undefined) {
      return this.addDefault(options.id)
    }

    // debug('add node=%d parent=%d weight=%d exclusive=%d',
    //   options.id,
    //   options.parent === null ? -1 : options.parent,
    //   options.weight || this.defaultWeight,
    //   options.exclusive ? 1 : 0)

    var children: PriorityNode[] | null = null
    if (options.exclusive) {
      children = parent!.removeChildren()
    }

    var node = new PriorityNode(this, {
      id: options.id,
      parent: parent,
      weight: options.weight || this.defaultWeight
    })
    this.map[options.id] = node

    if (children) {
      for (var i = 0; i < children.length; i++) {
        node.addChild(children[i])
      }
    }

    this.count++
    if (this.count > this.maxCount) {
      // debug('hit maximum remove id=%d', this.list[0].id)
      this.list.shift()!.remove()
    }

    // Root node is not subject to removal
    if (node.parent !== null) {
      this.list.push(node)
    }

    return node
  }

  // Only for testing, should use `node`'s methods
  get (id: number) {
    return this.map[id]
  }

  addDefault (id: number) {
    // debug('creating default node')
    return this.add({ id: id, parent: 0, weight: this.defaultWeight })
  }

  _removeNode (node: PriorityNode) {
    delete this.map[node.id]
    var index = binarySearch(this.list, node, compareChildren)
    this.list.splice(index, 1)
    this.count--
  }
}
