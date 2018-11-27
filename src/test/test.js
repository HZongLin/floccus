import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
const AsyncParallel = require('async-parallel')

chai.use(chaiAsPromised)
const expect = chai.expect

import Account from '../lib/Account'
import { Folder, Bookmark } from '../lib/Tree'
import AccountStorage from '../lib/AccountStorage'
import browser from '../lib/browser-api'

describe('Floccus', function() {
  this.timeout(60000) // no test should run longer than 60s
  before(async function() {
    const background = await browser.runtime.getBackgroundPage()
    background.controller.setEnabled(false)
  })
  after(async function() {
    const background = await browser.runtime.getBackgroundPage()
    background.controller.setEnabled(true)
  })
  ;[
    Account.getDefaultValues('fake'),
    {
      type: 'nextcloud',
      url: 'http://localhost/',
      username: 'admin',
      password: 'admin'
    },
    {
      type: 'nextcloud',
      url: 'http://localhost/',
      username: 'admin',
      password: 'admin',
      serverRoot: '/my folder/some subfolder'
    },
    {
      type: 'nextcloud-folders',
      url: 'http://localhost/',
      username: 'admin',
      password: 'admin'
    },
    {
      type: 'nextcloud-folders',
      url: 'http://localhost/',
      username: 'admin',
      password: 'admin',
      serverRoot: '/my folder/some subfolder'
    },
    {
      type: 'webdav',
      url: 'http://localhost/remote.php/webdav/',
      username: 'admin',
      password: 'admin',
      bookmark_file: 'bookmarks.xbel'
    }
  ].forEach(ACCOUNT_DATA => {
    describe(
      ACCOUNT_DATA.type +
        ' Account ' +
        (ACCOUNT_DATA.serverRoot ? ACCOUNT_DATA.serverRoot : ''),
      function() {
        var account
        beforeEach('set up account', async function() {
          account = await Account.create(ACCOUNT_DATA)
        })
        afterEach('clean up account', async function() {
          if (account) await account.delete()
        })
        it('should create an account', async function() {
          const secondInstance = await Account.get(account.id)
          expect(secondInstance.getData()).to.deep.equal(account.getData())
        })
        it('should save and restore an account', async function() {
          await account.setData(ACCOUNT_DATA)
          expect(account.getData()).to.deep.equal(ACCOUNT_DATA)

          const secondInstance = await Account.get(account.id)
          expect(secondInstance.getData()).to.deep.equal(ACCOUNT_DATA)
        })
        it('should delete an account', async function() {
          await account.delete()
          expect(Account.get(account.id)).to.be.rejected
          account = null // so afterEach notices it's deleted already
        })
        it('should not be initialized upon creation', async function() {
          expect(await account.isInitialized()).to.be.false
        })
      }
    )
    describe(ACCOUNT_DATA.type + ' Sync', function() {
      context('with one client', function() {
        var account
        beforeEach('set up account', async function() {
          account = await Account.create(ACCOUNT_DATA)
          if (ACCOUNT_DATA.type === 'fake') {
            account.server.bookmarksCache = new Folder({
              id: '',
              title: 'root'
            })
          }
          await account.init()
        })
        afterEach('clean up account', async function() {
          if (!account) return
          await browser.bookmarks.removeTree(account.getData().localRoot)
          if (ACCOUNT_DATA.type !== 'fake') {
            if (account.server.onSyncStart) {
              await account.server.onSyncStart()
            }
            let tree = await account.server.getBookmarksTree()
            await AsyncParallel.each(
              tree.children,
              async child => {
                if (child instanceof Folder) {
                  await account.server.removeFolder(child.id)
                } else {
                  await account.server.removeBookmark(child.id)
                }
              },
              1
            )
            if (account.server.onSyncComplete) {
              await account.server.onSyncComplete()
            }
          }
          await account.delete()
        })
        it('should create local bookmarks on the server', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync()
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: [
                        new Bookmark({ title: 'url', url: bookmark.url })
                      ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should update the server on local changes', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync() // propagate to server

          const newData = { title: 'blah' }
          await browser.bookmarks.update(bookmark.id, newData)
          await account.sync() // update on server
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: [
                        new Bookmark({
                          title: newData.title,
                          url: bookmark.url
                        })
                      ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should update the server on local removals', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync() // propagate to server

          await browser.bookmarks.remove(bookmark.id)
          await account.sync() // update on server
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: []
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should update the server on local folder moves', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'test',
            url: 'http://ureff.l/',
            parentId: fooFolder.id
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark2 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync() // propagate to server

          await browser.bookmarks.move(barFolder.id, { parentId: localRoot })
          await account.sync() // update on server
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Bookmark({ title: 'test', url: 'http://ureff.l/' })
                  ]
                }),
                new Folder({
                  title: 'bar',
                  children: [
                    new Bookmark({ title: 'url', url: 'http://ur.l/' })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should create server bookmarks locally', async function() {
          var adapter = account.server
          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTree = await adapter.getBookmarksTree()
          const fooFolderId = await adapter.createFolder(serverTree.id, 'foo')
          const barFolderId = await adapter.createFolder(fooFolderId, 'bar')
          const serverMark = {
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolderId
          }
          const bookmarkId = await adapter.createBookmark(
            new Bookmark(serverMark)
          )
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync()
          expect(account.getData().error).to.not.be.ok

          const tree = await account.localTree.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: [
                        new Bookmark({
                          title: serverMark.title,
                          url: serverMark.url
                        })
                      ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should update local bookmarks on server changes', async function() {
          var adapter = account.server

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTree = await adapter.getBookmarksTree()
          const fooFolderId = await adapter.createFolder(serverTree.id, 'foo')
          const barFolderId = await adapter.createFolder(fooFolderId, 'bar')
          const serverMark = {
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolderId
          }
          const serverMarkId = await adapter.createBookmark(
            new Bookmark(serverMark)
          )
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync() // propage creation

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const newServerMark = {
            ...serverMark,
            title: 'blah',
            id: serverMarkId
          }
          await adapter.updateBookmark(new Bookmark(newServerMark))
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync() // propage update
          expect(account.getData().error).to.not.be.ok

          const tree = await account.localTree.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: [
                        new Bookmark({
                          title: newServerMark.title,
                          url: newServerMark.url
                        })
                      ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should update local bookmarks on server removals', async function() {
          var adapter = account.server
          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTree = await adapter.getBookmarksTree()
          const fooFolderId = await adapter.createFolder(serverTree.id, 'foo')
          const barFolderId = await adapter.createFolder(fooFolderId, 'bar')
          const serverMark = {
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolderId
          }
          const serverMarkId = await adapter.createBookmark(
            new Bookmark(serverMark)
          )
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync() // propage creation

          if (adapter.onSyncStart) await adapter.onSyncStart()
          await adapter.removeBookmark(serverMarkId)
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync() // propage update
          expect(account.getData().error).to.not.be.ok

          const tree = await account.localTree.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: []
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should be able to handle duplicates', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const bookmarkData = {
            title: 'url',
            url: 'http://ur.l/'
          }
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const bookmark1 = await browser.bookmarks.create({
            ...bookmarkData,
            parentId: fooFolder.id
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark2 = await browser.bookmarks.create({
            ...bookmarkData,
            parentId: barFolder.id
          })
          await account.sync() // propagate to server

          await browser.bookmarks.move(barFolder.id, { parentId: localRoot })
          await account.sync() // update on server
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [new Bookmark(bookmarkData)]
                }),
                new Folder({
                  title: 'bar',
                  children: [new Bookmark(bookmarkData)]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should deduplicate unnormalized URLs', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          // create bookmark on server
          if (adapter.onSyncStart) await adapter.onSyncStart()
          var serverTree = await adapter.getBookmarksTree()
          const fooFolderId = await adapter.createFolder(serverTree.id, 'foo')
          const serverMark1 = {
            title: 'url',
            url: 'http://ur.l/?a=b&foo=b%C3%A1r+foo'
          }
          const serverMark2 = {
            title: 'url2',
            url: 'http://ur2.l/?a=b&foo=b%C3%A1r+foo'
          }
          const serverMarkId1 = await adapter.createBookmark(
            new Bookmark({ ...serverMark1, parentId: fooFolderId })
          )
          const serverMarkId2 = await adapter.createBookmark(
            new Bookmark({ ...serverMark2, parentId: fooFolderId })
          )
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          // create bookmark locally
          const localRoot = account.getData().localRoot
          const localMark1 = {
            title: 'url',
            url: 'http://ur.l/?foo=bár+foo&a=b'
          }
          const localMark2 = {
            title: 'url2',
            url: 'http://ur2.l/?foo=bár+foo&a=b'
          }
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const localMarkId1 = await browser.bookmarks.create({
            ...localMark1,
            parentId: fooFolder.id
          })
          const localMarkId2 = await browser.bookmarks.create({
            ...localMark2,
            parentId: fooFolder.id
          })

          await account.sync() // propagate to server

          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Bookmark(serverMark1),
                    new Bookmark(serverMark2)
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should not fail when moving both folders and contents', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'test',
            url: 'http://ureff.l/',
            parentId: fooFolder.id
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark2 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync() // propagate to server

          await browser.bookmarks.move(barFolder.id, { parentId: localRoot })
          await browser.bookmarks.move(fooFolder.id, { parentId: barFolder.id })
          await browser.bookmarks.move(bookmark1.id, { parentId: barFolder.id })
          await account.sync() // update on server
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'bar',
                  children: [
                    new Bookmark({ title: 'url', url: 'http://ur.l/' }),
                    new Bookmark({ title: 'test', url: 'http://ureff.l/' }),
                    new Folder({
                      title: 'foo',
                      children:
                        ACCOUNT_DATA.type !== 'nextcloud'
                          ? []
                          : [
                              // This is because of a peculiarity of the legacy adapter
                              new Bookmark({
                                title: 'test',
                                url: 'http://ureff.l/'
                              })
                            ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should handle strange characters well', async function() {
          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const localRoot = account.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo!"§$%&/()=?"',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: "bar=?*'Ä_:-^;",
            parentId: fooFolder.id
          })
          const bookmark = await browser.bookmarks.create({
            title: 'url|!"=)/§_:;Ä\'*ü"',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account.sync()
          expect(account.getData().error).to.not.be.ok

          await account.sync()
          expect(account.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'foo!"§$%&/()=?"',
                  children: [
                    new Folder({
                      title: "bar=?*'Ä_:-^;",
                      children: [
                        new Bookmark({
                          title: 'url|!"=)/§_:;Ä\'*ü"',
                          url: bookmark.url
                        })
                      ]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should be ok if both server and local bookmark are removed', async function() {
          var adapter = account.server

          if (adapter.onSyncStart) await adapter.onSyncStart()
          var serverTree = await adapter.getBookmarksTree()
          const fooFolderId = await adapter.createFolder(serverTree.id, 'foo')
          const barFolderId = await adapter.createFolder(fooFolderId, 'bar')
          const serverMark = {
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolderId
          }
          const serverMarkId = await adapter.createBookmark(
            new Bookmark(serverMark)
          )
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          await account.sync() // propagate creation

          if (adapter.onSyncStart) await adapter.onSyncStart()
          await adapter.removeBookmark(serverMarkId)
          if (adapter.onSyncComplete) await adapter.onSyncComplete()
          await account.sync() // propagate update

          expect(account.getData().error).to.not.be.ok
          const localTree = await account.localTree.getBookmarksTree()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          serverTree = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          // Root must also be equal in the assertion
          localTree.title = serverTree.title

          expectTreeEqual(localTree, serverTree)
        })
        it('should sync nested accounts correctly', async function() {
          const localRoot = account.getData().localRoot
          const nestedAccountFolder = await browser.bookmarks.create({
            title: 'nestedAccount',
            parentId: localRoot
          })

          let nestedAccount = await Account.create({
            ...Account.getDefaultValues('fake'),
            localRoot: nestedAccountFolder.id
          })
          nestedAccount.server.bookmarksCache = new Folder({
            id: '',
            title: 'root'
          })
          await nestedAccount.init()

          var adapter = account.server
          expect((await adapter.getBookmarksTree()).children).to.have.lengthOf(
            0
          )

          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: localRoot
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          const bookmark2 = await browser.bookmarks.create({
            title: 'url2',
            url: 'http://ur2.l/',
            parentId: nestedAccountFolder.id
          })
          await account.sync() // propagate to server
          await nestedAccount.sync() // propagate to server

          expect(account.getData().error).to.not.be.ok
          expect(nestedAccount.getData().error).to.not.be.ok

          const tree = await adapter.getBookmarksTree()
          expectTreeEqual(
            tree,
            new Folder({
              title: tree.title,
              children: [
                new Folder({
                  title: 'bar',
                  children: [
                    new Bookmark({ title: 'url', url: 'http://ur.l/' })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        if (~ACCOUNT_DATA.type.indexOf('nextcloud')) {
          it('should leave alone unaccepted bookmarks entirely', async function() {
            const localRoot = account.getData().localRoot

            var adapter = account.server
            expect(
              (await adapter.getBookmarksTree()).children
            ).to.have.lengthOf(0)

            const barFolder = await browser.bookmarks.create({
              title: 'bar',
              parentId: localRoot
            })
            const fooFolder = await browser.bookmarks.create({
              title: 'foo',
              parentId: barFolder.id
            })
            const bookmark1 = await browser.bookmarks.create({
              title: 'url',
              url: 'http://ur.l/',
              parentId: barFolder.id
            })
            const bookmark2 = await browser.bookmarks.create({
              title: 'url2',
              url: 'javascript:void(0)',
              parentId: fooFolder.id
            })
            await account.sync() // propagate to server
            expect(account.getData().error).to.not.be.ok

            await account.sync() // propagate to server -- if we had cached the unacceptables, they'd be deleted now
            expect(account.getData().error).to.not.be.ok

            const tree = await adapter.getBookmarksTree()
            expectTreeEqual(
              tree,
              new Folder({
                title: tree.title,
                children: [
                  new Folder({
                    title: 'bar',
                    children: [
                      new Bookmark({ title: 'url', url: 'http://ur.l/' }),
                      new Folder({
                        title: 'foo',
                        children: []
                      })
                    ]
                  })
                ]
              }),
              ACCOUNT_DATA.type === 'nextcloud'
            )

            const localTree = await account.localTree.getBookmarksTree()
            expectTreeEqual(
              localTree,
              new Folder({
                title: localTree.title,
                children: [
                  new Folder({
                    title: 'bar',
                    children: [
                      new Bookmark({ title: 'url', url: 'http://ur.l/' }),
                      new Folder({
                        title: 'foo',
                        children: [
                          new Bookmark({
                            title: 'url2',
                            url: 'javascript:void(0)'
                          })
                        ]
                      })
                    ]
                  })
                ]
              }),
              ACCOUNT_DATA.type === 'nextcloud'
            )
          })
        }

        if (ACCOUNT_DATA.type !== 'nextcloud') {
          it('should synchronize ordering', async function() {
            var adapter = account.server
            expect(
              (await adapter.getBookmarksTree()).children
            ).to.have.lengthOf(0)

            const localRoot = account.getData().localRoot
            const fooFolder = await browser.bookmarks.create({
              title: 'foo',
              parentId: localRoot
            })
            const folder1 = await browser.bookmarks.create({
              title: 'folder1',
              parentId: fooFolder.id
            })
            const folder2 = await browser.bookmarks.create({
              title: 'folder2',
              parentId: fooFolder.id
            })
            const bookmark1 = await browser.bookmarks.create({
              title: 'url1',
              url: 'http://ur.l/',
              parentId: fooFolder.id
            })
            const bookmark2 = await browser.bookmarks.create({
              title: 'url2',
              url: 'http://ur.ll/',
              parentId: fooFolder.id
            })
            await account.sync()
            expect(account.getData().error).to.not.be.ok

            await browser.bookmarks.move(bookmark1.id, { index: 0 })
            await browser.bookmarks.move(folder1.id, { index: 1 })
            await browser.bookmarks.move(bookmark2.id, { index: 2 })
            await browser.bookmarks.move(folder2.id, { index: 3 })

            await account.sync()
            expect(account.getData().error).to.not.be.ok

            const localTree = await account.localTree.getBookmarksTree()
            expectTreeEqual(
              localTree,
              new Folder({
                title: localTree.title,
                children: [
                  new Folder({
                    title: 'foo',
                    children: [
                      new Bookmark({
                        title: 'url1',
                        url: bookmark1.url
                      }),
                      new Folder({
                        title: 'folder1',
                        children: []
                      }),
                      new Bookmark({
                        title: 'url2',
                        url: bookmark2.url
                      }),
                      new Folder({
                        title: 'folder2',
                        children: []
                      })
                    ]
                  })
                ]
              }),
              false,
              true
            )

            const tree = await adapter.getBookmarksTree()
            expectTreeEqual(
              tree,
              new Folder({
                title: tree.title,
                children: [
                  new Folder({
                    title: 'foo',
                    children: [
                      new Bookmark({
                        title: 'url1',
                        url: bookmark1.url
                      }),
                      new Folder({
                        title: 'folder1',
                        children: []
                      }),
                      new Bookmark({
                        title: 'url2',
                        url: bookmark2.url
                      }),
                      new Folder({
                        title: 'folder2',
                        children: []
                      })
                    ]
                  })
                ]
              }),
              false,
              true
            )
          })
        }
      })
      context('with two clients', function() {
        var account1, account2
        beforeEach('set up accounts', async function() {
          account1 = await Account.create(ACCOUNT_DATA)
          await account1.init()
          account2 = await Account.create(ACCOUNT_DATA)
          await account2.init()

          if (ACCOUNT_DATA.type === 'fake') {
            // Wrire both accounts to the same fake db
            account2.server.bookmarksCache = account1.server.bookmarksCache = new Folder(
              { id: '', title: 'root' }
            )
          }
        })
        afterEach('clean up accounts', async function() {
          await browser.bookmarks.removeTree(account1.getData().localRoot)
          if (ACCOUNT_DATA.type !== 'fake') {
            if (account1.server.onSyncStart) {
              await account1.server.onSyncStart()
            }
            let tree1 = await account1.server.getBookmarksTree()
            await Promise.all(
              tree1.children.map(async child => {
                if (child instanceof Folder) {
                  await account1.server.removeFolder(child.id)
                } else {
                  await account1.server.removeBookmark(child.id)
                }
              })
            )
            if (account1.server.onSyncComplete) {
              await account1.server.onSyncComplete()
            }
          }
          await account1.delete()
          await browser.bookmarks.removeTree(account2.getData().localRoot)
          if (ACCOUNT_DATA.type !== 'fake') {
            if (account1.server.onSyncStart) {
              await account1.server.onSyncStart()
            }
            let tree2 = await account2.server.getBookmarksTree()
            await Promise.all(
              tree2.children.map(async child => {
                if (child instanceof Folder) {
                  await account2.server.removeFolder(child.id)
                } else {
                  await account2.server.removeBookmark(child.id)
                }
              })
            )
            if (account1.server.onSyncComplete) {
              await account1.server.onSyncComplete()
            }
          }
          await account2.delete()
        })
        it('should propagate edits using "last write wins"', async function() {
          var adapter = account1.server

          const localRoot = account1.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          await account1.sync()
          await account2.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTree = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          const tree1 = await account1.localTree.getBookmarksTree()
          const tree2 = await account2.localTree.getBookmarksTree()
          tree1.title = tree2.title
          expectTreeEqual(tree1, tree2)
          tree2.title = serverTree.title
          expectTreeEqual(tree2, serverTree)

          await browser.bookmarks.update(bookmark1.id, {
            title: 'NEW TITLE FROM ACC1'
          })
          await account1.sync()

          const bm2Id = (await account2.localTree.getBookmarksTree())
            .children[0].children[0].children[0].id
          const newBookmark2 = await browser.bookmarks.update(bm2Id, {
            title: 'NEW TITLE FROM ACC2'
          })
          await account2.sync()

          await account1.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTreeAfterSyncing = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()
          expectTreeEqual(
            serverTreeAfterSyncing,
            new Folder({
              title: serverTreeAfterSyncing.title,
              children: [
                new Folder({
                  title: 'foo',
                  children: [
                    new Folder({
                      title: 'bar',
                      children: [new Bookmark(newBookmark2)]
                    })
                  ]
                })
              ]
            }),
            ACCOUNT_DATA.type === 'nextcloud'
          )

          const tree1AfterSyncing = await account1.localTree.getBookmarksTree()
          const tree2AfterSyncing = await account2.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterSyncing,
            tree2AfterSyncing,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          tree2AfterSyncing.title = serverTreeAfterSyncing.title
          expectTreeEqual(
            tree2AfterSyncing,
            serverTreeAfterSyncing,
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        it('should overtake moves to a different client', async function() {
          var adapter = account1.server

          const localRoot = account1.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          const tree1 = await account1.localTree.getBookmarksTree()
          await account1.sync()
          await account2.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTreeAfterFirstSync = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          const tree1AfterFirstSync = await account1.localTree.getBookmarksTree()
          const tree2AfterFirstSync = await account2.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterFirstSync.title = tree1.title
          expectTreeEqual(
            serverTreeAfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          tree2AfterFirstSync.title = tree1.title
          expectTreeEqual(
            tree2AfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('First round ok')

          await browser.bookmarks.move(bookmark1.id, { parentId: fooFolder.id })
          console.log('acc1: Moved bookmark from bar into foo')

          const tree1BeforeSecondSync = await account1.localTree.getBookmarksTree()
          await account1.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTreeAfterSecondSync = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          const tree1AfterSecondSync = await account1.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterSecondSync,
            tree1BeforeSecondSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterSecondSync.title = tree1AfterSecondSync.title
          expectTreeEqual(
            serverTreeAfterSecondSync,
            tree1AfterSecondSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('Second round first half ok')

          await account2.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTreeAfterThirdSync = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          const tree2AfterThirdSync = await account2.localTree.getBookmarksTree()
          expectTreeEqual(
            tree2AfterThirdSync,
            tree1AfterSecondSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterThirdSync.title = tree2AfterThirdSync.title
          expectTreeEqual(
            serverTreeAfterThirdSync,
            tree2AfterThirdSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('Second round second half ok')

          console.log('acc1: final sync')
          await account1.sync()

          if (adapter.onSyncStart) await adapter.onSyncStart()
          const serverTreeAfterFinalSync = await adapter.getBookmarksTree()
          if (adapter.onSyncComplete) await adapter.onSyncComplete()

          const tree1AfterFinalSync = await account1.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterFinalSync,
            tree2AfterThirdSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          tree2AfterThirdSync.title = serverTreeAfterFinalSync.title
          expectTreeEqual(
            tree2AfterThirdSync,
            serverTreeAfterFinalSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
        // Skipping this, because nextcloud adapter currently
        // isn't able to track bookmarks across dirs, thus in this
        // scenario both bookmarks survive :/
        it.skip('should propagate moves using "last write wins"', async function() {
          var adapter = account1.server

          const localRoot = account1.getData().localRoot
          const fooFolder = await browser.bookmarks.create({
            title: 'foo',
            parentId: localRoot
          })
          const barFolder = await browser.bookmarks.create({
            title: 'bar',
            parentId: fooFolder.id
          })
          const bookmark1 = await browser.bookmarks.create({
            title: 'url',
            url: 'http://ur.l/',
            parentId: barFolder.id
          })
          const tree1 = await account1.localTree.getBookmarksTree()
          await account1.sync()
          await account2.sync()

          const serverTreeAfterFirstSync = await adapter.getBookmarksTree()
          const tree1AfterFirstSync = await account1.localTree.getBookmarksTree()
          const tree2AfterFirstSync = await account2.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterFirstSync.title = tree1.title
          expectTreeEqual(
            serverTreeAfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          tree2AfterFirstSync.title = tree1.title
          expectTreeEqual(
            tree2AfterFirstSync,
            tree1,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('First round ok')

          await browser.bookmarks.move(bookmark1.id, { parentId: fooFolder.id })
          console.log('acc1: Moved bookmark from bar into foo')

          const tree1BeforeSecondSync = await account1.localTree.getBookmarksTree()
          await account1.sync()

          const serverTreeAfterSecondSync = await adapter.getBookmarksTree()
          const tree1AfterSecondSync = await account1.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterSecondSync,
            tree1BeforeSecondSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterSecondSync.title = tree1AfterSecondSync.title
          expectTreeEqual(
            serverTreeAfterSecondSync,
            tree1AfterSecondSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('Second round first half ok')

          const bm2Id = (await account2.localTree.getBookmarksTree())
            .children[0].children[0].children[0].id
          await browser.bookmarks.move(bm2Id, {
            parentId: account2.getData().localRoot
          })
          console.log('acc2: Moved bookmark from bar into root')
          const tree2BeforeThirdSync = await account2.localTree.getBookmarksTree()
          await account2.sync()

          const serverTreeAfterThirdSync = await adapter.getBookmarksTree()
          const tree2AfterThirdSync = await account2.localTree.getBookmarksTree()
          expectTreeEqual(
            tree2AfterThirdSync,
            tree2BeforeThirdSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          serverTreeAfterThirdSync.title = tree2AfterThirdSync.title
          expectTreeEqual(
            serverTreeAfterThirdSync,
            tree2AfterThirdSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          console.log('Second round second half ok')

          console.log('acc1: final sync')
          await account1.sync()

          const serverTreeAfterFinalSync = await adapter.getBookmarksTree()
          const tree1AfterFinalSync = await account1.localTree.getBookmarksTree()
          expectTreeEqual(
            tree1AfterFinalSync,
            tree2AfterThirdSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
          tree2AfterThirdSync.title = serverTreeAfterFinalSync.title
          expectTreeEqual(
            tree2AfterThirdSync,
            serverTreeAfterFinalSync,
            ACCOUNT_DATA.type === 'nextcloud'
          )
        })
      })
    })
  })
})

function expectTreeEqual(tree1, tree2, ignoreEmptyFolders, checkOrder) {
  try {
    expect(tree1.title).to.equal(tree2.title)
    if (tree2.url) {
      expect(tree1.url).to.equal(tree2.url)
    } else {
      if (!checkOrder) {
        tree2.children.sort((a, b) => {
          if (a.title < b.title) return -1
          if (a.title > b.title) return 1
          return 0
        })
        tree1.children.sort((a, b) => {
          if (a.title < b.title) return -1
          if (a.title > b.title) return 1
          return 0
        })
      }
      let children1 = ignoreEmptyFolders
        ? tree1.children.filter(child => !hasNoBookmarks(child))
        : tree1.children
      let children2 = ignoreEmptyFolders
        ? tree2.children.filter(child => !hasNoBookmarks(child))
        : tree2.children
      expect(children1).to.have.length(children2.length)
      children2.forEach((child2, i) => {
        expectTreeEqual(children1[i], child2, ignoreEmptyFolders, checkOrder)
      })
    }
  } catch (e) {
    console.log(
      `Trees are not equal: (checkOrder: ${checkOrder}, ignoreEmptyFolders: ${ignoreEmptyFolders})`,
      'Tree 1:\n' + tree1.inspect(0) + '\n',
      'Tree 2:\n' + tree2.inspect(0)
    )
    throw e
  }
}

function hasNoBookmarks(child) {
  if (child instanceof Bookmark) return false
  else return !child.children.some(child => !hasNoBookmarks(child))
}
