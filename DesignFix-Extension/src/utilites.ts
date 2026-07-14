import * as vscode from 'vscode';
import * as path from 'path';
import { writeFile } from 'fs/promises';
import * as fs from 'fs';
import { Constants } from './Constants';
import { convertJavaToXml, extractFirstSourceUnit } from './srcmlRunner';





export async function findFileAndReadContent(fileName: string) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
  }

  const folderUri = workspaceFolder.uri;
  const fileContent = await findFileRecursively(folderUri, fileName);
  if (fileContent) {
      return fileContent;
  }

  vscode.window.showErrorMessage(`File ${fileName} not found in workspace.`);
}

async function findFileRecursively(folderUri: vscode.Uri, fileName: string): Promise<string | undefined> {
  const directoryEntries = await vscode.workspace.fs.readDirectory(folderUri);

  for (const [name, type] of directoryEntries) {
      const entryUri = vscode.Uri.joinPath(folderUri, name);

      if (type === vscode.FileType.File && name === fileName) {
          const fileContent = await vscode.workspace.fs.readFile(entryUri);
          return Buffer.from(fileContent).toString('utf8');
      } else if (type === vscode.FileType.Directory) {
          const fileContent = await findFileRecursively(entryUri, fileName);
          if (fileContent) {
              return fileContent;
          }
      }
  }

  return undefined;
}


export function debounce<T extends (...args: any[]) => void>(
  func: T, 
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null;
  return function(...args: Parameters<T>) {
      if (timeout) {
          clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
          func(...args);
      }, wait);
  };
}




export async function writeToFile(filePath: string, exprText: string): Promise<void> {
  try {
    await writeFile(filePath, exprText, 'utf-8');
    console.log("File written successfully");
  } catch (e) {
    console.error("Error in writing the result xml", e);
  }
}

export function convertToXML(inputFilePath: string): Promise<string> {
  return convertJavaToXml(inputFilePath);
}

export function findLineNumber(xmlFilePath: string): Promise<string> {
  console.log("XMLFILEPATH: ",xmlFilePath);
  return extractFirstSourceUnit(xmlFilePath);
}



interface FileProperties {
  canonicalPath: string;
  parent: string;
  name: string;
  isDirectory: boolean;
  fileType?: string; // Optional, only for files
  fileName?: string; // Optional, added property for file name including extension
}


interface DirectoryJson {
children: DirectoryJson[];
properties: FileProperties;
}

export function buildFolderHierarchy(rootPath: string): DirectoryJson | null {
const stats = fs.statSync(rootPath);
if (!stats.isDirectory()) {
  return null; // rootPath is not a directory
}

const rootDirectory: DirectoryJson = {
  children: [],
  properties: {
    canonicalPath: rootPath,
    parent: "",
    name: path.basename(rootPath),
    isDirectory: true,
  },
};

function traverseDirectory(currentPath: string, parentNode: DirectoryJson) {
  fs.readdirSync(currentPath, { withFileTypes: true }).forEach((dirent) => {
    const fullPath = path.join(currentPath, dirent.name);
    const isDirectory = dirent.isDirectory();
    const childNode: DirectoryJson = {
      children: [],
      properties: {
        canonicalPath: fullPath.replace(/\\/g, '/'),
        parent: currentPath.replace(/\\/g, '/'),
        name: isDirectory ? dirent.name : path.basename(dirent.name, path.extname(dirent.name)),
        isDirectory: isDirectory,
        // Include fileName for files
        ...(isDirectory ? {} : { fileName: dirent.name }) // Conditionally add fileName if it's a file
      },
    };

    if (!isDirectory) {
      // Include fileType for files
      if (shouldIgnoreFileForProjectHierarchy(fullPath)){ return;};
      childNode.properties.fileType = path.extname(dirent.name).substring(1);
    }

    parentNode.children.push(childNode);

    // Recursively traverse if it's a directory
    if (isDirectory) {
      traverseDirectory(fullPath, childNode);
    }
  });
}


traverseDirectory(rootPath, rootDirectory);
return rootDirectory;
}

function shouldIgnoreFileForProjectHierarchy(filePath: string): boolean {
//const TEMP_JAVA_FILE = "Temp.java"; // Adjust this to your temporary Java file's criteria
// Ignore non-Java files and the specific temporary Java file
return !filePath.endsWith('.java') || path.basename(filePath) === Constants.TEMP_JAVA_FILE;
}




