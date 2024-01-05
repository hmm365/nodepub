const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const zip = require("archiver");
const structuralFiles = require("./constituents/structural.js");
const markupFiles = require("./constituents/markup.js");
const util = require("./utility.js");

// 문서 객체를 생성합니다.
const document = (metadata, generateContentsCallback) => {
  const self = this;
  self.CSS = "";
  self.sections = [];
  self.images = [];
  self.metadata = metadata;
  self.generateContentsCallback = generateContentsCallback;
  self.showContents = true;
  self.filesForTOC = [];
  self.coverImage = "";
  self.fonts = [];

  // 기본 검증.
  const required = ["title", "author", "cover"];
  if (metadata == null) throw new Error("메타데이터 누락");
  required.forEach((field) => {
    const prop = metadata[field];
    if (
      prop == null ||
      typeof prop === "undefined" ||
      prop.toString().trim() === ""
    ) {
      throw new Error(`메타데이터 누락: ${field}`);
    }
    if (field === "cover") {
      self.coverImage = prop;
    }
  });
  if (
    metadata.showContents !== null &&
    typeof metadata.showContents !== "undefined"
  ) {
    self.showContents = metadata.showContents;
  }

  // 제목과 (HTML) 내용을 사용하여 새로운 섹션 항목을 추가합니다. 내용 목차에서 제외할 수 있습니다.
  // Front Matter인 경우 내용 목차 앞에 나타납니다.
  // overrideFilename은 선택 사항이며, EPUB 내에서 사용되는 이름을 나타냅니다.
  // 기본적으로 파일 이름은 자동으로 번호가 매겨집니다. 확장자를 지정해서는 안 됩니다.
  self.addSection = (
    title,
    content,
    excludeFromContents,
    isFrontMatter,
    overrideFilename
  ) => {
    let filename = overrideFilename;
    if (
      filename == null ||
      typeof filename === "undefined" ||
      filename.toString().trim() === ""
    ) {
      const i = self.sections.length + 1;
      filename = `s${i}`;
    }
    filename = `${filename}.xhtml`;
    self.sections.push({
      title,
      content,
      excludeFromContents: excludeFromContents || false,
      isFrontMatter: isFrontMatter || false,
      filename,
    });
  };

  // EPUB에 CSS 파일을 추가합니다. 이는 모든 섹션에서 공유됩니다.
  self.addCSS = (content) => {
    self.CSS = content;
  };

  // EPUB에 폰트를 추가합니다.
  self.addFont = (fontPath) => {
    self.fonts.push(fontPath);
  };

  // 현재까지 추가된 섹션의 수를 가져옵니다.
  self.getSectionCount = () => self.sections.length;

  // EPUB에 필요한 파일을 객체 배열로 가져옵니다.
  // 유효한 EPUB 파일을 위해 'compress:false'는 반드시 준수되어야 합니다.
  self.getFilesForEPUB = async () => {
    const syncFiles = [];
    const asyncFiles = [];

    // 필수 파일.
    syncFiles.push({
      name: "mimetype",
      folder: "",
      compress: false,
      content: structuralFiles.getMimetype(),
    });
    syncFiles.push({
      name: "container.xml",
      folder: "META-INF",
      compress: true,
      content: structuralFiles.getContainer(self),
    });
    syncFiles.push({
      name: "ebook.opf",
      folder: "OEBPF",
      compress: true,
      content: structuralFiles.getOPF(self),
    });
    syncFiles.push({
      name: "navigation.ncx",
      folder: "OEBPF",
      compress: true,
      content: structuralFiles.getNCX(self),
    });
    syncFiles.push({
      name: "cover.xhtml",
      folder: "OEBPF",
      compress: true,
      content: markupFiles.getCover(self),
    });

    // 선택적 파일.
    syncFiles.push({
      name: "ebook.css",
      folder: "OEBPF/css",
      compress: true,
      content: markupFiles.getCSS(self),
    });
    for (let i = 1; i <= self.sections.length; i += 1) {
      const fname = self.sections[i - 1].filename;
      syncFiles.push({
        name: `${fname}`,
        folder: "OEBPF/content",
        compress: true,
        content: markupFiles.getSection(self, i),
      });
    }

    // 목차 마크업.
    if (self.showContents) {
      syncFiles.push({
        name: "toc.xhtml",
        folder: "OEBPF/content",
        compress: true,
        content: markupFiles.getTOC(self),
      });
    }

    // 선택적 폰트.
    if (self.metadata.fonts) {
      self.metadata.fonts.forEach((font) => {
        const fontFilename = path.basename(font);
        asyncFiles.push({
          name: fontFilename,
          folder: "OEBPF/fonts",
          compress: true,
          content: font,
        });
      });
    }

    // 추가 이미지 - 파일 이름을 content 속성에 추가하고 비동기 처리를 위해 준비합니다.
    const coverFilename = path.basename(self.coverImage);
    asyncFiles.push({
      name: coverFilename,
      folder: "OEBPF/images",
      compress: true,
      content: self.coverImage,
    });
    if (self.metadata.images) {
      self.metadata.images.forEach((image) => {
        const imageFilename = path.basename(image);
        asyncFiles.push({
          name: imageFilename,
          folder: "OEBPF/images",
          compress: true,
          content: image,
        });
      });
    }

    // 이제 비동기 맵을 사용하여 파일 내용을 가져옵니다.
    await util.forEachAsync(asyncFiles, async (file) => {
      const data = await fsPromises.readFile(file.content);
      const loaded = {
        name: file.name,
        folder: file.folder,
        compress: file.compress,
        content: data,
      };
      syncFiles.push(loaded);
    });
    // console.log(syncFiles);
    // 파일 목록 반환.
    return syncFiles;
  };

  // EPUB 파일을 위해 필요한 파일을 폴더 구조에 작성합니다.
  // 유효한 EPUB 파일의 경우 'mimetype'은 반드시 EPUB에서 첫 번째 항목이어야 하며 압축해서는 안 됩니다.
  self.writeFilesForEPUB = async (folder) => {
    const files = await self.getFilesForEPUB();
    await util.makeFolder(folder);
    await util.forEachAsync(files, async (file) => {
      if (file.folder.length > 0) {
        const f = `${folder}/${file.folder}`;
        await util.makeFolder(f);
        await fsPromises.writeFile(`${f}/${file.name}`, file.content);
      } else {
        await fsPromises.writeFile(`${folder}/${file.name}`, file.content);
      }
    });
  };

  // EPUB을 작성합니다. 파일 이름에는 확장자를 지정해서는 안 됩니다.
  self.writeEPUB = async (folder, filename) => {
    const files = await self.getFilesForEPUB();

    // 압축 시작.
    await util.makeFolder(folder);
    const output = fs.createWriteStream(`${folder}/${filename}.epub`);
    const archive = zip("zip", { store: false });
    archive.on("error", (archiveErr) => {
      throw archiveErr;
    });

    await new Promise((resolveWrite) => {
      // 파일 디스크립터가 작성될 때까지 대기합니다.
      archive.pipe(output);
      output.on("close", () => resolveWrite());

      // 파일 내용을 씁니다.
      files.forEach((file) => {
        if (file.folder.length > 0) {
          archive.append(file.content, {
            name: `${file.folder}/${file.name}`,
            store: !file.compress,
          });
        } else {
          archive.append(file.content, {
            name: file.name,
            store: !file.compress,
          });
        }
      });

      // 완료.
      archive.finalize();
    });
  };

  return self;
};

exports.document = document;
