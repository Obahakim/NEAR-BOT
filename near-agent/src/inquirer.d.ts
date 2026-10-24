declare module "inquirer" {
  const inquirer: {
    prompt: (questions: any[]) => Promise<any>;
  };
  export default inquirer;
}
