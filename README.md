# Model Gallery (Blockbench Plugin)

リソースパック内の CEM（`.jem`）やバニラモデル（`.json`）を自動走査し、3D サムネイル付きのギャラリーとして一覧表示する [Blockbench](https://www.blockbench.net/) プラグインです。

## デモ動画

https://github.com/user-attachments/assets/d574d335-83d1-49b1-a923-bb75fe5548b2

## 主な機能

- フォルダを指定して配下のモデルファイルを再帰的にスキャン（`.jem` / `.json` / `.bbmodel` など、Blockbench に登録された対応拡張子を自動検出）
- 各モデルの 3D プレビューを自動生成し、タイル状のギャラリーで表示
- 複数フォルダの追加読み込み（Add Folder）、まとめての再生成（Refresh）
- ファイル名・パスによる検索フィルタ
- ギャラリー内容を単体の HTML ファイルとしてエクスポート
- タイルをクリックすると、そのモデルを Blockbench エディタで直接開ける

## 動作環境

- Blockbench 4.8.0 以降（`variant: both` のため、Desktop 版・Web 版のどちらでも動作想定）

## インストール方法

### 方法A: URL から読み込む（お試し・簡易導入向け）

1. Blockbench を起動し、メニューから **File → Plugins** を開く
2. 右上の **Load Plugin from URL** を選択
3. このリポジトリの `model_gallery.js` の raw URL を入力
   - `https://github.com/alumina6767/model-gallery/raw/refs/heads/master/model_gallery.js`
4. 読み込み後、**Tools** メニューに **Open Model Gallery** が追加されます

### 方法B: ローカルフォルダにコピーする（開発・オフライン向け）

1. このリポジトリ（`plugin.json` と `model_gallery.js` を含むフォルダ）を、Blockbench のデータフォルダ配下の `plugins/model_gallery/` にコピーします
   - Windows の例: `%appdata%\Blockbench\plugins\model_gallery\`
2. Blockbench を再起動、または Plugins 画面から再読み込みします

## 使い方

1. **Tools → Open Model Gallery** でギャラリーを開く
2. **Add Folder** でリソースパックのフォルダ（`assets` を含む階層など）を選択
3. スキャンされたモデルのサムネイルが自動生成され、タイル表示される
4. 検索ボックスでファイル名・パスによる絞り込みが可能
5. タイルをクリックするとそのモデルを Blockbench で開く
6. **Refresh** で読み込み済みの全フォルダを再スキャン
7. **Export** でギャラリー内容を単体の HTML として書き出し
8. **Reset** で表示中のギャラリー情報（サムネイル・フォルダ選択）をクリア（元のファイルは削除されません）

## 既知の制限事項

- `.json` ファイルはバニラモデル判定のヒューリスティックで対象を絞り込んでいます。大規模なリソースパックでは、まれに意図しないファイルが含まれる／除外される場合があります
- サムネイル生成は安定性を優先して逐次処理のため、モデル数が多いフォルダでは時間がかかることがあります

## ライセンス

[MIT License](./LICENSE)

## 変更履歴

[CHANGELOG.md](./CHANGELOG.md) を参照してください。
