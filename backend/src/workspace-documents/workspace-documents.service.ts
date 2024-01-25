import { Injectable, NotFoundException } from "@nestjs/common";
import { Document, Prisma } from "@prisma/client";
import { PrismaService } from "src/db/prisma.service";
import { FindWorkspaceDocumentsResponse } from "./types/find-workspace-documents-response.type";
import { CreateWorkspaceDocumentShareTokenResponse } from "./types/create-workspace-document-share-token-response.type";
import { ShareRole } from "src/utils/types/share-role.type";
import { generateRandomKey } from "src/utils/functions/random-string";
import { ConfigService } from "@nestjs/config";
import { FindDocumentFromYorkieResponse } from "./types/find-document-from-yorkie-response.type";
import * as moment from "moment";
import { connect } from "http2";

@Injectable()
export class WorkspaceDocumentsService {
	constructor(
		private prismaService: PrismaService,
		private configService: ConfigService
	) {}

	async create(userId: string, workspaceId: string, title: string) {
		try {
			await this.prismaService.userWorkspace.findFirstOrThrow({
				where: {
					userId,
					workspaceId,
				},
			});
		} catch (e) {
			throw new NotFoundException();
		}

		return this.prismaService.document.create({
			data: {
				title,
				workspaceId,
				yorkieDocumentId: Math.random().toString(36).substring(7),
			},
		});
	}

	async findMany(
		userId: string,
		workspaceId: string,
		pageSize: number,
		cursor?: string
	): Promise<FindWorkspaceDocumentsResponse> {
		try {
			await this.prismaService.userWorkspace.findFirstOrThrow({
				where: {
					userId,
					workspaceId,
				},
			});
		} catch (e) {
			throw new NotFoundException();
		}

		const additionalOptions: Prisma.DocumentFindManyArgs = {};

		if (cursor) {
			additionalOptions.cursor = { id: cursor };
		}

		const documentList = await this.prismaService.document.findMany({
			take: pageSize + 1,
			where: {
				workspaceId,
			},
			orderBy: {
				id: "desc",
			},
			...additionalOptions,
		});

		const slicedDocumentList = documentList.slice(0, pageSize);
		const mergedDocumentList = await Promise.all(
			slicedDocumentList.map(async (doc) => {
				// Get updatedAt field from Yorkie server
				return this.findDocumentFromYorkie(doc.yorkieDocumentId).then((yorkieDoc) => {
					return {
						...doc,
						updatedAt: moment(yorkieDoc.document.updatedAt).toDate(),
					};
				});
			})
		);

		return {
			documents: mergedDocumentList,
			cursor: documentList.length > pageSize ? documentList[pageSize].id : null,
		};
	}

	async findOne(userId: string, workspaceId: string, documentId: string) {
		try {
			await this.prismaService.userWorkspace.findFirstOrThrow({
				where: {
					userId,
					workspaceId,
				},
			});

			return this.prismaService.document.findUniqueOrThrow({
				where: {
					id: documentId,
				},
			});
		} catch (e) {
			throw new NotFoundException();
		}
	}

	async createSharingToken(
		userId: string,
		workspaceId: string,
		documentId: string,
		role: ShareRole,
		expirationDate: Date
	): Promise<CreateWorkspaceDocumentShareTokenResponse> {
		let document: Document;

		try {
			await this.prismaService.userWorkspace.findFirstOrThrow({
				where: {
					userId,
					workspaceId,
				},
			});

			document = await this.prismaService.document.findUniqueOrThrow({
				where: {
					id: documentId,
					workspaceId,
				},
			});
		} catch (e) {
			throw new NotFoundException();
		}

		const token = generateRandomKey();

		await this.prismaService.documentSharingToken.create({
			data: {
				documentId: document.id,
				token,
				expiredAt: expirationDate,
				role,
			},
		});

		return {
			sharingToken: token,
		};
	}

	async findDocumentFromYorkie(documentKey: string): Promise<FindDocumentFromYorkieResponse> {
		return new Promise((resolve, reject) => {
			const client = connect(`${this.configService.get<string>("YORKIE_API_ADDR")}`);

			client.on("error", (err) => reject(err));

			const requestBody = JSON.stringify({
				project_name: this.configService.get<string>("YORKIE_PROJECT_NAME"),
				document_key: documentKey,
			});
			const req = client.request({
				":method": "POST",
				":path": "/yorkie.v1.AdminService/GetDocument",
				"Content-Type": "application/json",
				"content-length": Buffer.byteLength(requestBody),
				Authorization: this.configService.get<string>("YORKIE_PROJECT_SECRET_KEY"),
			});

			req.write(requestBody);
			req.setEncoding("utf8");
			let data = "";

			req.on("data", (chunk) => {
				data += chunk;
			});

			req.on("end", () => {
				client.close();
				resolve(JSON.parse(data) as FindDocumentFromYorkieResponse);
			});

			req.end();
		});
	}
}
